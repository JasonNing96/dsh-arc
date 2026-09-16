/**
 * ACP client for one runtime endpoint.
 *
 * Owns the runtime subprocess, the JSON-RPC connection, and per-session
 * bookkeeping. Session updates and permission requests are surfaced through
 * callbacks; protocol failures are mapped to typed {@link AcpError}s that
 * keep the wire `data` payload (DSH puts actionable details in `data.details`,
 * e.g. quota errors from the model provider).
 *
 * @module personal-dsh-tui/acp-client
 */

import type { Checkpoint } from './handoff.js'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { remoteSshArgs, type RemoteConfig } from './remote-config.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type Stream,
} from '@agentclientprotocol/sdk'
import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'

export type { PromptResponse, RequestPermissionRequest, RequestPermissionResponse }

/** A protocol- or lifecycle-level failure with a user-presentable message. */
export class AcpError extends Error {
  constructor(
    message: string,
    /** Protocol error code when the failure came from a JSON-RPC error. */
    readonly code: number | undefined,
    /** Structured `data` payload from the wire, if any. */
    readonly data: unknown = undefined,
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

/** One entry of a `session/list` result. */
export interface SessionListEntry {
  readonly sessionId: string
  readonly cwd: string
  readonly title: string | null
  readonly updatedAt: string | null
}

/** Runtime events the UI needs to render beyond prompt completion. */
export interface AcpEventHandlers {
  onStream?: (sessionId: string, frame: AssistantStreamFrame) => void
  /** Called for every `session/update` notification. */
  onUpdate: (sessionId: string, update: SessionNotification['update']) => void
  /**
   * Called when the runtime asks for a permission decision. The returned
   * settle function must eventually be called with an explicit user choice;
   * there is no automatic approval. Call it with `cancelled` to deny.
   */
  onRequestPermission: (
    sessionId: string,
    request: RequestPermissionRequest,
    settle: (response: RequestPermissionResponse) => void,
  ) => void
  /** Called at most once when the connection drops or the process dies. */
  onDisconnect: (reason: string) => void
}

/** Connection state used for status display. */
export type ConnectionState = 'starting' | 'ready' | 'disconnected'

const DISPOSE_TIMEOUT_MS = 5000

/**
 * A connected ACP client owning one runtime subprocess.
 *
 * Lifecycle: spawn, initialize, then create the user's session. Only the
 * known provider-registration startup race is retried, for at most 2 seconds.
 */
export class AcpClient {
  private connection: ClientConnection | undefined
  private child: ChildProcess | undefined
  private state: ConnectionState = 'starting'
  private readonly pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>()
  private stderrTail = ''
  private disposed = false
  private disconnectEmitted = false
  private nextPermissionKey = 0
  private readonly sessionModels = new Map<string, string>()

  private constructor(
    /** Identity of the runtime endpoint, for state namespacing. */
    readonly runtimeId: string,
    private readonly handlers: AcpEventHandlers,
  ) {}

  /**
   * Spawn the pinned dsh runtime in ACP mode and initialize.
   *
   * The subprocess argv is fully explicit — no shell interpolation. Its
   * `DSH_HOME` points at the dedicated runtime home so the global `~/.dsh`
   * stays untouched. The workspace `cwd` becomes both the process cwd (DSH's
   * sandbox policy derives `workspaceRoot` from `process.cwd()`) and the
   * default ACP session cwd.
   */
  static async connect(
    runtimeId: string,
    executable: string,
    dshHome: string,
    cwd: string,
    handlers: AcpEventHandlers,
    signal?: AbortSignal,
    arcProfile?: string,
  ): Promise<AcpClient> {
    const acp = await AcpClient.spawnRuntime(
      runtimeId,
      process.execPath,
      arcProfile === undefined
        ? ['--import', fileURLToPath(new URL('./runtime-hook.js', import.meta.url)), executable, '--profile', 'acp']
        : [executable, '--profile', arcProfile],
      { ...process.env, DSH_HOME: dshHome },
      cwd,
      handlers,
      signal,
    )
    if (arcProfile !== undefined) await acp.requireArcPlugin()
    return acp
  }

  /**
   * Spawn the bundled demo runtime as a subprocess and initialize. No
   * credentials, no network, no model: clearly labeled demo.
   */
  static async connectDemo(runtimeId: string, cwd: string, handlers: AcpEventHandlers): Promise<AcpClient> {
    const cliEntry = fileURLToPath(new URL('./demo-runtime.js', import.meta.url))
    return AcpClient.spawnRuntime(
      runtimeId,
      process.execPath,
      [cliEntry],
      { ...process.env, DSH_TUI_DEMO: '1' },
      cwd,
      handlers,
    )
  }

  /** SSH owns this ACP connection. Reconnection creates a new runtime process. */
  static async connectRemote(runtimeId: string, remote: RemoteConfig, handlers: AcpEventHandlers,
    signal?: AbortSignal): Promise<AcpClient> {
    const acp = await AcpClient.spawnRuntime(runtimeId, 'ssh', remoteSshArgs(remote), process.env,
      process.cwd(), handlers, signal, remote.cwd)
    if (remote.arcProfile !== undefined) await acp.requireArcPlugin()
    return acp
  }

  /** Common subprocess wiring for the real and demo runtimes. */
  private static async spawnRuntime(
    runtimeId: string,
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    handlers: AcpEventHandlers,
    signal?: AbortSignal,
    sessionCwd?: string,
  ): Promise<AcpClient> {
    signal?.throwIfAborted()
    const acp = new AcpClient(runtimeId, handlers)
    acp.launchCwd = sessionCwd ?? cwd
    let child: ChildProcess
    try {
      child = spawn(executable, args, {
        env,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
    } catch (error) {
      throw new AcpError(`无法启动 runtime（${executable}）：${errorText(error)}`, undefined)
    }
    acp.child = child
    const stdout = child.stdout
    const stdin = child.stdin
    if (stdout === null || stdin === null) {
      child.kill('SIGKILL')
      throw new AcpError('runtime 子进程未提供 stdio 管道', undefined)
    }
    acp.wireProcessEvents(child)
    const stream: Stream = ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    )
    acp.attach(stream)
    const abort = (): void => { acp.handleDisconnect('连接已取消'); void acp.dispose() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      await acp.initialize()
    } catch (error) {
      await acp.dispose()
      throw error
    } finally { signal?.removeEventListener('abort', abort) }
    return acp
  }

  /**
   * Create a client over an already-established stream (tests). Runs
   * `initialize` over that stream.
   */
  static async connectStream(runtimeId: string, stream: Stream, handlers: AcpEventHandlers): Promise<AcpClient> {
    const acp = new AcpClient(runtimeId, handlers)
    acp.attach(stream)
    await acp.initialize()
    return acp
  }

  private attach(stream: Stream): void {
    const app = createClientApp({ name: 'personal-dsh-tui' })
      .onNotification('_dsh/stream', value => value as { sessionId: string; frame: AssistantStreamFrame }, ({ params }) => {
        this.handlers.onStream?.(params.sessionId, params.frame)
      })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'config_option_update') {
          this.rememberModel(params.sessionId, params.update.configOptions)
        }
        this.handlers.onUpdate(params.sessionId, params.update)
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => {
        return new Promise<RequestPermissionResponse>((resolvePromise) => {
          const key = `perm-${this.nextPermissionKey += 1}`
          const settle = (response: RequestPermissionResponse): void => {
            this.pendingPermissions.delete(key)
            resolvePromise(response)
          }
          this.pendingPermissions.set(key, settle)
          // Connection loss or runtime-side cancellation while awaiting the
          // user must deny, never approve.
          signal?.addEventListener('abort', () => {
            const pending = this.pendingPermissions.get(key)
            if (pending !== undefined) settle({ outcome: { outcome: 'cancelled' } })
          }, { once: true })
          this.handlers.onRequestPermission(params.sessionId, params, settle)
        })
      })
    this.connection = app.connect(stream)
    // connection.closed rejects on transport failure and resolves on clean
    // close; both must emit disconnect exactly once and deny pending asks.
    void this.connection.closed.then(
      () => { this.handleDisconnect('connection closed') },
      (error: unknown) => { this.handleDisconnect(`connection error: ${errorText(error)}`) },
    )
  }

  private handleDisconnect(reason: string): void {
    for (const settle of this.pendingPermissions.values()) settle({ outcome: { outcome: 'cancelled' } })
    this.pendingPermissions.clear()
    if (this.state === 'disconnected') {
      // Still surface process-level detail even if already disconnected.
      if (!this.disconnectEmitted && !this.disposed) this.handlers.onDisconnect(reason)
      if (!this.disconnectEmitted) this.disconnectEmitted = true
      return
    }
    this.state = 'disconnected'
    if (!this.disposed) this.handlers.onDisconnect(reason)
    this.disconnectEmitted = true
  }

  private wireProcessEvents(child: ChildProcess): void {
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000) })
    child.on('error', error => {
      this.stderrTail = error.message
      this.handleDisconnect(`runtime 进程错误：${error.message}`)
      this.connection?.close()
    })
    child.on('exit', (code, signal) => {
      const detail = this.stderrTail.trim().split('\n').at(-1) ?? ''
      this.handleDisconnect(`runtime 进程已退出（code ${String(code)}, signal ${String(signal)}）${detail ? `：${detail}` : ''}`)
      this.connection?.close()
    })
  }

  private async initialize(): Promise<void> {
    const response = await this.guard(async () => {
      const conn = this.requireConnection()
      return conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'personal-dsh-tui', version: '0.1.0' },
      })
    }, 'initialize')
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      this.state = 'disconnected'
      await this.dispose()
      throw new AcpError(
        `runtime 使用 ACP 协议版本 ${String(response.protocolVersion)}，客户端要求 ${String(PROTOCOL_VERSION)}`,
        undefined,
      )
    }
    this.adapterVersion = response._meta?.dshTuiAdapter
    this.arcPluginVersion = response._meta?.dshArcPlugin
    this.state = 'ready'
  }

  /** Current connection state for status display. */
  get connectionState(): ConnectionState {
    return this.state
  }

  /** Whether a live connection exists. */
  get connected(): boolean {
    return this.state === 'ready' && this.connection !== undefined
  }

  private requireConnection(): ClientConnection {
    if (this.connection === undefined || this.state === 'disconnected') {
      throw new AcpError('runtime 连接不可用（可能已退出——请重启 TUI）', undefined)
    }
    return this.connection
  }

  /** Create a new session in the runtime at `cwd`. */
  private adapterVersion: unknown
  private arcPluginVersion: unknown
  private async requireArcPlugin(): Promise<void> {
    if (this.arcPluginVersion === 1) return
    await this.dispose()
    throw new AcpError('指定的 profile 未启用 ARC ACP 插件；请检查 dsh-arc/acp 配置', undefined)
  }

  async exportCheckpoint(sessionId: string): Promise<Checkpoint> {
    if (this.adapterVersion !== 1) throw new AcpError('目标 runtime 缺少上下文投切适配器，请更新后再试', undefined)
    return this.guard(() => this.requireConnection().agent.request<Checkpoint>('_dsh/checkpoint', { sessionId }), 'checkpoint/export')
  }

  async newSession(cwd?: string, checkpoint?: Checkpoint): Promise<string> {
    if (checkpoint !== undefined && this.adapterVersion !== 1) throw new AcpError('目标 runtime 缺少上下文投切适配器', undefined)
    const deadline = Date.now() + 2000
    for (;;) {
      try {
        const response = await this.guard(async () => {
          return this.requireConnection().agent.request(methods.agent.session.new, { cwd: cwd ?? this.launchCwd, mcpServers: [], ...(checkpoint === undefined ? {} : { _meta: { dshCheckpoint: checkpoint as unknown as Record<string, unknown> } }) })
        }, 'session/new')
        this.rememberModel(response.sessionId, response.configOptions)
        return response.sessionId
      } catch (error) {
        if (!isAdapterRegistrationRace(error) || Date.now() >= deadline) throw error
        await delay(200)
      }
    }
  }

  /**
   * Resume a persisted session. The runtime verifies the workspace matches
   * the session's canonical cwd; a mismatch is a caller-visible error.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    const response = await this.guard(async () => {
      const conn = this.requireConnection()
      return conn.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] })
    }, 'session/resume')
    this.rememberModel(sessionId, response.configOptions)
  }

  /** List persisted, resumable sessions; optionally filtered by workspace. */
  async listSessions(cwd?: string): Promise<SessionListEntry[]> {
    const response = await this.guard(async () => {
      const conn = this.requireConnection()
      return conn.agent.request(methods.agent.session.list, { cwd: cwd ?? this.launchCwd })
    }, 'session/list')
    return response.sessions.map((entry) => ({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      title: entry.title ?? null,
      updatedAt: entry.updatedAt ?? null,
    }))
  }

  /**
   * Send one prompt. Resolves with the turn's stop reason after committed
   * updates drain. One prompt at a time per session is the runtime's
   * contract; the UI enforces it.
   */
  async prompt(sessionId: string, text: string, cancellationSignal?: AbortSignal): Promise<PromptResponse> {
    return this.guard(async () => {
      const conn = this.requireConnection()
      return conn.agent.request(
        methods.agent.session.prompt,
        { sessionId, prompt: [{ type: 'text', text }] },
        cancellationSignal === undefined ? {} : { cancellationSignal },
      )
    }, 'session/prompt')
  }

  /**
   * Cancel the in-flight prompt (or autonomous work) of a session. A no-op
   * when nothing is running.
   */
  async cancel(sessionId: string): Promise<void> {
    for (const settle of this.pendingPermissions.values()) settle({ outcome: { outcome: 'cancelled' } })
    await this.guard(async () => {
      const conn = this.requireConnection()
      return conn.agent.notify(methods.agent.session.cancel, { sessionId })
    }, 'session/cancel')
  }

  /** Explicitly close a session; the runtime persists it for later resume. */
  async closeSession(sessionId: string): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConnection()
      return conn.agent.request(methods.agent.session.close, { sessionId })
    }, 'session/close')
  }

  modelFor(sessionId: string | undefined): string {
    return sessionId === undefined ? '未连接模型' : this.sessionModels.get(sessionId) ?? '模型由 runtime 配置'
  }

  private rememberModel(sessionId: string, options: unknown): void {
    if (!Array.isArray(options)) return
    const model = options.find(option => option.category === 'model')
    if (typeof model?.currentValue !== 'string') return
    let label = model.currentValue
    try {
      const pair: unknown = JSON.parse(label)
      if (Array.isArray(pair) && typeof pair[1] === 'string') label = pair[1]
    } catch { /* Non-JSON model identifiers are already readable. */ }
    this.sessionModels.set(sessionId, label)
  }

  private launchCwd = process.cwd()

  /** Workspace cwd the subprocess was launched in. */
  get workspaceCwd(): string {
    return this.launchCwd
  }

  private async guard<T>(operation: () => Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      if (what === 'session/prompt' || what === 'session/cancel') return await operation()
      // A stalled SSH control request must not freeze switching or clean quit.
      // Timeouts have an unknown outcome: close transport, never replay a request.
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const message = `${what} 超时；请求结果未知，请重连后检查会话`
          this.handleDisconnect(message)
          void this.dispose()
          reject(new AcpError(message, undefined))
        }, 15_000)
      })
      return await Promise.race([operation(), timeout])
    } catch (error) {
      const parsed = toAcpError(error, what)
      const detail = this.stderrTail.trim().split('\n').at(-1)
      if (what === 'initialize' && detail) throw new AcpError(`${parsed.message}；${detail}`, parsed.code, parsed.data)
      throw parsed
    }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  /**
   * Tear down: close the connection, deny pending permissions, and stop the
   * subprocess within a bounded window. Safe to call more than once.
   */
  private disposal: Promise<void> | undefined
  dispose(): Promise<void> {
    return this.disposal ??= this.doDispose()
  }

  private async doDispose(): Promise<void> {
    this.disposed = true
    for (const settle of this.pendingPermissions.values()) settle({ outcome: { outcome: 'cancelled' } })
    this.pendingPermissions.clear()
    this.state = 'disconnected'
    this.connection?.close()
    this.connection = undefined
    const child = this.child
    this.child = undefined
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, DISPOSE_TIMEOUT_MS)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      })
    }
  }
}

/** The one retryable startup race: unpublished settings route for a provider. */
function isAdapterRegistrationRace(error: unknown): boolean {
  if (!(error instanceof AcpError) || error.code !== -32603) return false
  const details = extractDetails(error.data)
  return details.includes('no adapter registered for provider')
}

/** Pull `data.details` (or string data) out of a structured error payload. */
function extractDetails(data: unknown): string {
  if (typeof data === 'string') return data
  if (data !== null && typeof data === 'object' && 'details' in data) {
    const details = (data as { details: unknown }).details
    if (typeof details === 'string') return details
    try {
      return JSON.stringify(details)
    } catch {
      return ''
    }
  }
  return ''
}

/** Convert any thrown value into an {@link AcpError} with a readable message. */
export function toAcpError(error: unknown, what: string): AcpError {
  if (error instanceof AcpError) return error
  const anyError = error as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof anyError?.code === 'number' && typeof anyError?.message === 'string') {
    const details = extractDetails(anyError.data)
    const detail = details.length > 0 ? `（${details}）` : ''
    return new AcpError(`${what} 失败：${anyError.message}${detail}`, anyError.code, anyError.data)
  }
  return new AcpError(`${what} 失败：${errorText(error)}`, undefined)
}

/** Human-safe rendering of an unknown thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Temporary directory helper for tests. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(joinPath(tmpdir(), prefix))
}

/** Recursive removal that never throws for a missing path. */
export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
