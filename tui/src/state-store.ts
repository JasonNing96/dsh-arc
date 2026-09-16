/**
 * TUI-owned state: transcript mirrors and drafts.
 *
 * Layout under the state directory, namespaced by runtime identity so a
 * demo runtime, two different dsh homes, or a future remote endpoint never
 * share session mirrors:
 *
 * ```text
 * <stateDir>/runtimes/<runtimeId>/sessions/<safeId>.json   transcript mirror
 * <stateDir>/runtimes/<runtimeId>/lock.json                exclusive lock
 * <stateDir>/runtimes/<runtimeId>/drafts/<safeId>.txt      per-session draft
 * ```
 *
 * Writes are atomic (temp file + rename) with owner-only permissions.
 * Protocol session IDs are opaque strings, never used as filesystem paths:
 * each is hashed to a safe filename while the original stays inside the
 * JSON payload. An exclusive-create lock file prevents two live writers; existing
 * locks are refused, including stale/partially-written locks, to avoid races.
 *
 * @module personal-dsh-tui/state-store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** One transcript entry as rendered by the UI. */
export interface TranscriptEntry {
  /** Monotonic sequence within the mirror. */
  readonly seq: number
  /** Wall-clock time the entry was recorded (ms since epoch). */
  readonly time: number
  readonly kind:
    | 'user'
    | 'assistant'
    | 'thought'
    | 'tool'
    | 'tool_result'
    | 'usage'
    | 'status'
    | 'error'
    | 'permission'
  /** Human-readable content already rendered from ACP updates. */
  readonly text: string
  /** For tool entries: the protocol tool call id. */
  readonly toolCallId?: string
  /** For tool entries: in_progress / completed / failed. */
  readonly toolStatus?: 'in_progress' | 'completed' | 'failed'
}

/** A persisted session mirror. */
export interface SessionMirror {
  readonly conversationId?: string
  /** Protocol session ID (kept verbatim; never a filesystem path). */
  readonly sessionId: string
  /** Absolute workspace cwd the session runs in. */
  readonly cwd: string
  /** When the mirror was created (ms since epoch). */
  readonly createdAt: number
  /** When the mirror was last written (ms since epoch). */
  readonly updatedAt: number
  /** Ordered transcript entries. */
  readonly entries: TranscriptEntry[]
  /** Set once this client has observed a genuine ACP resume of the session. */
  readonly resumedAt: number | null
  /** Set when the runtime reported the session cannot be resumed. */
  readonly unresumableReason?: string
  /**
   * Set for sessions that existed in the runtime before this client ever
   * recorded them: history display is unavailable, not silently empty.
   */
  readonly historyUnavailable?: boolean
}

interface LockFile {
  readonly pid: number
  readonly startedAt: number
}

/**
 * Storage for one runtime endpoint's TUI-owned state.
 *
 * Concurrency: `open` acquires an exclusive lock with O_EXCL create. A live
 * process holding the lock is refused; a stale lock needs manual removal. All writes serialize through an in-process chain, and
 * {@link close} releases only the lock this instance created.
 */
export class StateStore {
  private writeChain: Promise<unknown> = Promise.resolve()
  private lockHeld = false

  private constructor(
    /** Runtime-namespaced root directory. */
    readonly root: string,
    private readonly lockToken: string,
  ) {}

  /** Mark this instance as the live lock holder. */
  private markLocked(): void {
    this.lockHeld = true
  }

  /**
   * Open (or create) the store for one runtime identity under `stateDir`.
   * @throws when another live process holds the lock for this runtime.
   */
  static async open(stateDir: string, runtimeId: string): Promise<StateStore> {
    const root = join(resolve(stateDir), 'runtimes', safeSegment(runtimeId))
    await mkdir(join(root, 'sessions'), { recursive: true, mode: 0o700 })
    await mkdir(join(root, 'drafts'), { recursive: true, mode: 0o700 })
    const lockPath = join(root, 'lock.json')
    const token = `${process.pid.toString(36)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`

    for (;;) {
      // Exclusive create: succeeds only when no lock file exists.
      let handle
      try {
        handle = await open(lockPath, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A contender can observe a newly created lock before its owner writes
        // the PID. Never unlink an unreadable lock or race another recovery.
        let existing: LockFile | undefined
        try {
          existing = JSON.parse(await readFile(lockPath, 'utf8')) as LockFile
        } catch {
          existing = undefined
        }
        if (existing === undefined || typeof existing.pid !== 'number' || !processAlive(existing.pid)) {
          throw new Error(`状态锁正在初始化、已失效或不可读：${lockPath}。确认没有 TUI 进程后，可移除此锁文件再启动；会话文件不会删除。`)
        }
        throw new Error(
          `另一个 TUI 进程（pid ${String(existing.pid)}）正在使用 ${root}；请先关闭它，或用 --state-dir 指定其他目录`,
        )
      }
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token })}\n`, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      const store = new StateStore(root, token)
      store.markLocked()
      return store
    }
  }

  /** Absolute root directory of this store (tests, diagnostics). */
  get directory(): string {
    return this.root
  }

  /** Path of the mirror file for a protocol session ID. */
  private mirrorPath(sessionId: string): string {
    return join(this.root, 'sessions', `${safeSegment(sessionId)}.json`)
  }

  /** Path of the draft file for a protocol session ID. */
  private draftPath(sessionId: string): string {
    return join(this.root, 'drafts', `${safeSegment(sessionId)}.txt`)
  }

  /** Load the mirror for a session, or null when this client never recorded it. */
  async loadMirror(sessionId: string): Promise<SessionMirror | null> {
    try {
      const raw = JSON.parse(await readFile(this.mirrorPath(sessionId), 'utf8')) as SessionMirror
      if (raw.sessionId !== sessionId) return null
      return raw
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** All mirrors this client recorded, newest activity first. */
  async listMirrors(): Promise<SessionMirror[]> {
    const dir = join(this.root, 'sessions')
    const files = await readdirSafe(dir)
    const mirrors: SessionMirror[] = []
    for (const file of files) {
      if (!/^[0-9a-f]{64}\.json$/.test(file)) continue
      try {
        const mirror = JSON.parse(await readFile(join(dir, file), 'utf8')) as SessionMirror
        if (typeof mirror.sessionId === 'string') mirrors.push(mirror)
      } catch {
        // A corrupt mirror must not break listing; skip it.
      }
    }
    return mirrors.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Create or replace a mirror wholesale (first record, external adoption). */
  async writeMirror(mirror: SessionMirror): Promise<void> {
    return this.enqueue(async () => {
      await atomicWrite(this.mirrorPath(mirror.sessionId), `${JSON.stringify(mirror, null, 2)}\n`)
    })
  }

  /**
   * Append one transcript entry to a mirror, creating it on first use.
   * Resolves to the stored mirror after the append is durably on disk.
   */
  async append(
    sessionId: string,
    cwd: string,
    entry: Omit<TranscriptEntry, 'seq' | 'time'>,
  ): Promise<SessionMirror> {
    return this.enqueue(async () => {
      const existing = await this.loadMirrorUnchecked(sessionId)
      const now = Date.now()
      const nextSeq = existing === null || existing.entries.length === 0
        ? 0
        : (existing.entries.at(-1)?.seq ?? 0) + 1
      const mirror: SessionMirror = existing === null
        ? {
            sessionId,
            cwd,
            createdAt: now,
            updatedAt: now,
            entries: [{ ...entry, seq: nextSeq, time: now }],
            resumedAt: null,
          }
        : {
            ...existing,
            cwd,
            updatedAt: now,
            entries: [...existing.entries, { ...entry, seq: nextSeq, time: now }],
          }
      await atomicWrite(this.mirrorPath(sessionId), `${JSON.stringify(mirror, null, 2)}\n`)
      return mirror
    })
  }

  /** Mark a mirror as genuinely resumed through ACP. */
  async markResumed(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = await this.loadMirrorUnchecked(sessionId)
      if (existing === null) return
      await atomicWrite(this.mirrorPath(sessionId), `${JSON.stringify({ ...existing, resumedAt: Date.now() }, null, 2)}\n`)
    })
  }

  /** Record that the runtime refused to resume this session. */
  async markUnresumable(sessionId: string, reason: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = await this.loadMirrorUnchecked(sessionId)
      if (existing === null) return
      await atomicWrite(
        this.mirrorPath(sessionId),
        `${JSON.stringify({ ...existing, unresumableReason: reason }, null, 2)}\n`,
      )
    })
  }

  /** Save the current draft for a session (empty string removes it). */
  async saveDraft(sessionId: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      if (text.length === 0) {
        await rmQuiet(this.draftPath(sessionId))
        return
      }
      await atomicWrite(this.draftPath(sessionId), text)
    })
  }

  /** Load the saved draft for a session ('' when none). */
  async loadDraft(sessionId: string): Promise<string> {
    try {
      return await readFile(this.draftPath(sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /**
   * Release the lock on clean shutdown. Only removes the lock this instance
   * wrote; a recovered-then-stolen lock is never removed by its old owner.
   */
  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.lockHeld) return
      try {
        const raw = await readFile(join(this.root, 'lock.json'), 'utf8')
        const parsed = JSON.parse(raw) as { token?: unknown }
        if (parsed.token === this.lockToken) {
          await unlink(join(this.root, 'lock.json')).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.lockHeld = false
    })
    this.lockHeld = false
  }

  /** Test seam: whether this instance believes it holds the lock. */
  get locked(): boolean {
    return this.lockHeld
  }

  private async loadMirrorUnchecked(sessionId: string): Promise<SessionMirror | null> {
    try {
      return JSON.parse(await readFile(this.mirrorPath(sessionId), 'utf8')) as SessionMirror
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation)
    this.writeChain = next.catch(() => undefined)
    return next
  }
}

/**
 * Map an opaque protocol session ID to a filesystem-safe segment.
 *
 * Injective for practical inputs (full hex sha-256); never contains path
 * separators, `..`, or NUL, so an arbitrary session ID cannot escape storage.
 */
export function safeSegment(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

/**
 * Write `data` to `path` atomically: a sibling temp file with owner-only
 * permissions, fsync, then rename over the target.
 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temp, path)
  } finally { await rmQuiet(temp) }
}

/** Read a directory, treating a missing directory as empty. */
async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Unlink, ignoring a missing file. */
async function rmQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Whether a process id is alive on this host (best effort). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
