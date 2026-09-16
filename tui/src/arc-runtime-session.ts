/** ACP session state for execution-driver consumers; no renderer or terminal I/O. */
import { randomUUID } from 'node:crypto'
import type { AcpClient, AcpEventHandlers, RequestPermissionRequest, RequestPermissionResponse } from './acp-client.js'
import type { ArcConversationMirror, ArcInputState, ArcSession } from './arc-session-port.js'
import type { SessionMirror, StateStore, TranscriptEntry } from './state-store.js'

interface PendingPermission {
  readonly id: string
  readonly title: string
  readonly request: RequestPermissionRequest
  readonly settle: (response: RequestPermissionResponse) => void
}
interface LiveBlock { readonly kind: 'assistant' | 'thought'; text: string }
const CANCEL_GRACE_MS = 3000

export class ArcRuntimeSession implements ArcSession {
  private currentId: string | undefined
  private conversationId: string | undefined
  private entries: TranscriptEntry[] = []
  private input: ArcInputState = { buffer: '', cursor: 0 }
  private active = false
  private closing = false
  private closePromise: Promise<void> | undefined
  private state: ArcSession['running'] = 'idle'
  private error = ''
  private unsaved = ''
  private transition = ''
  private abortTransition: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private promptTask: Promise<void> | undefined
  private promptAbort: AbortController | undefined
  private promptSent = false
  private stopping: Promise<void> | undefined
  private permission: PendingPermission | undefined
  private liveAttempt: string | undefined
  private readonly live = new Map<number, LiveBlock>()

  constructor(private readonly client: AcpClient, private readonly store: StateStore,
    readonly config: { readonly cwd: string; readonly location: string }) {}

  get sessionId(): string | undefined { return this.currentId }
  get conversation(): string | undefined { return this.conversationId }
  get running(): ArcSession['running'] { return this.state }
  get pendingPermission(): PendingPermission | undefined { return this.permission }
  get errorText(): string { return this.error }
  get unsavedWarning(): string { return this.unsaved }
  get transitionText(): string { return this.transition }
  get uiState(): ArcInputState { return this.input }
  get inputComplete(): boolean { return true }
  get transcript(): readonly TranscriptEntry[] { return this.entries }
  /** Transient preview is separate from the durable ACP transcript. */
  get preview(): readonly LiveBlock[] { return [...this.live.values()].map(block => ({ ...block })) }
  onChange(listener: () => void): void { this.listeners.add(listener) }
  private changed(): void { if (!this.closing) for (const listener of this.listeners) listener() }
  setActive(active: boolean): void { this.active = active }
  showError(text: string): void { this.error = text; this.changed() }
  setTransition(text: string, cancel?: () => void): void { this.transition = text; this.abortTransition = cancel; this.changed() }
  restoreInput(state: ArcInputState): void { this.input = { ...state } }
  async flushInput(signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); await this.writes; signal?.throwIfAborted() }

  private persist(operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.then(operation)
    this.writes = pending.catch(error => {
      // Sticky failure: a later successful draft write must not certify lost history.
      this.unsaved = `ARC state was not saved: ${String(error)}`
      this.changed()
    })
    return pending
  }
  private record(kind: TranscriptEntry['kind'], text: string, extra: Partial<TranscriptEntry> = {}): Promise<void> {
    const sessionId = this.currentId
    // Incoming events are fenced in clientHandlers. Internal shutdown records
    // still need persistence so an unknown outcome survives the next launch.
    if (sessionId === undefined) return Promise.resolve()
    const entry: TranscriptEntry = { ...extra, seq: (this.entries.at(-1)?.seq ?? -1) + 1, time: Date.now(), kind, text }
    this.entries.push(entry)
    this.changed()
    return this.persist(async () => { await this.store.append(sessionId, this.config.cwd, entry) })
  }
  async saveDraftNow(): Promise<void> {
    const sessionId = this.currentId
    if (sessionId !== undefined) {
      const text = this.input.buffer
      await this.persist(() => this.store.saveDraft(sessionId, text))
    }
    if (this.unsaved) throw new Error(this.unsaved)
  }
  async exportConversationMirror(): Promise<ArcConversationMirror> {
    await this.writes
    if (this.unsaved) throw new Error(this.unsaved)
    if (!this.currentId || !this.conversationId) throw new Error('No active ARC conversation')
    const mirror = await this.store.loadMirror(this.currentId)
    if (!mirror) throw new Error('ARC conversation mirror is missing')
    return { entries: mirror.entries, createdAt: mirror.createdAt, conversationId: this.conversationId, input: this.uiState }
  }
  async adoptConversation(sessionId: string, source: ArcConversationMirror): Promise<void> {
    if (this.state !== 'idle') throw new Error('Cannot adopt into a running session')
    const mirror: SessionMirror = { sessionId, conversationId: source.conversationId, cwd: this.config.cwd,
      createdAt: source.createdAt, updatedAt: Date.now(), resumedAt: null, entries: source.entries.map(entry => ({ ...entry })) }
    await this.store.writeMirror(mirror)
    await this.store.saveDraft(sessionId, source.input.buffer)
    this.install(mirror, source.input)
  }
  private install(mirror: SessionMirror, input: ArcInputState): void {
    this.currentId = mirror.sessionId; this.conversationId = mirror.conversationId ?? mirror.sessionId
    this.entries = mirror.entries.map(entry => ({ ...entry }))
    this.input = { ...input }; this.live.clear(); this.liveAttempt = undefined; this.error = ''
    this.changed()
  }
  async createSession(): Promise<boolean> {
    if (this.currentId !== undefined || this.closing) return false
    let sessionId: string | undefined
    try {
      sessionId = await this.client.newSession(this.config.cwd)
      const mirror: SessionMirror = { sessionId, conversationId: sessionId, cwd: this.config.cwd,
        createdAt: Date.now(), updatedAt: Date.now(), resumedAt: null, entries: [] }
      await this.store.writeMirror(mirror)
      this.install(mirror, { buffer: '', cursor: 0 })
      return true
    } catch (error) {
      if (sessionId !== undefined && this.client.connected) {
        try { await this.client.closeSession(sessionId) } catch (cleanup) {
          this.showError(`Session creation failed: ${String(error)}; cleanup failed: ${String(cleanup)}`)
          return false
        }
      }
      this.showError(`Session creation failed: ${String(error)}`)
      return false
    }
  }
  async resumeSession(sessionId: string): Promise<boolean> {
    if (this.currentId !== undefined || this.closing) return false
    try {
      // Recover only a known mirror; never present an unknown session as empty.
      const mirror = await this.store.loadMirror(sessionId)
      if (!mirror) throw new Error('Saved ARC transcript is unavailable')
      const buffer = await this.store.loadDraft(sessionId)
      await this.client.resumeSession(sessionId, this.config.cwd)
      await this.store.markResumed(sessionId)
      this.install(mirror, { buffer, cursor: buffer.length })
      return true
    } catch (error) { this.showError(`Session resume failed: ${String(error)}`); return false }
  }

  submit(text: string): boolean {
    if (!this.active || this.closing || this.transition || this.state !== 'idle' || !this.currentId ||
        !this.client.connected || this.unsaved || !text.trim()) return false
    this.state = 'busy'; this.error = ''; this.input = { buffer: '', cursor: 0 }; this.stopping = undefined
    this.promptAbort = new AbortController()
    this.promptTask = this.runPrompt(this.currentId, text, this.promptAbort)
    this.changed()
    return true
  }
  private async runPrompt(sessionId: string, text: string, controller: AbortController): Promise<void> {
    try {
      await this.record('user', text)
      await this.saveDraftNow()
      controller.signal.throwIfAborted()
      this.promptSent = true
      await this.client.prompt(sessionId, text, controller.signal)
    } catch (error) {
      if (!this.closing) {
        this.error = !this.client.connected
          ? `${this.error.startsWith('Disconnected:') ? this.error : 'Disconnected: transport lost'}; runtime outcome is unknown. Reconnect and inspect before retrying.`
          : controller.signal.aborted ? 'Turn cancelled' : `Prompt failed: ${String(error)}`
        await this.record('error', this.error).catch(() => undefined) // persist already exposes a sticky failure.
      }
    } finally {
      this.denyPermission()
      // A preview not superseded by a committed ACP message remains explicitly incomplete.
      const incomplete = [...this.live.values()]
      this.live.clear(); this.liveAttempt = undefined
      for (const block of incomplete) {
        if (block.text) await this.record(block.kind, `[Incomplete output] ${block.text}`).catch(() => undefined)
      }
      await this.writes
      this.promptSent = false; this.promptAbort = undefined; this.state = 'idle'; this.changed()
    }
  }
  async waitForIdle(): Promise<void> { await this.promptTask }
  async cancel(): Promise<void> {
    if (this.transition) { this.abortTransition?.(); return }
    if (this.state === 'idle' || !this.currentId) return
    this.state = 'cancelling'; this.denyPermission(); this.changed()
    await this.stopPrompt()
  }
  private stopPrompt(): Promise<void> { return this.stopping ??= this.drainPrompt() }
  private async drainPrompt(): Promise<void> {
    const task = this.promptTask
    if (!task || this.state === 'idle') return
    // SDK cancellation only sends a notification; it does not settle a request
    // if the peer ignores it. Keep ownership until completion or transport loss.
    this.promptAbort?.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure: string | undefined
    const draining = (async () => {
      if (this.promptSent && this.currentId) await this.client.cancel(this.currentId)
      await task
      return true
    })()
    try {
      const complete = await Promise.race([draining, new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), CANCEL_GRACE_MS)
      })])
      if (!complete) failure = 'Cancellation timed out; runtime outcome is unknown. Reconnect and inspect before retrying.'
    } catch (error) {
      failure = `Cancellation failed; runtime outcome is unknown: ${String(error)}`
    } finally { if (timer !== undefined) clearTimeout(timer) }
    if (failure) {
      await this.client.dispose()
      await task
      this.showError(failure)
      await this.record('error', failure).catch(() => undefined) // Sticky persistence failure is already visible.
    }
  }
  replyPermission(id: string, outcome: 'allow' | 'deny'): void {
    const permission = this.permission
    if (!permission || permission.id !== id) return // cancellation may already have settled it.
    this.permission = undefined
    const kind = outcome === 'allow' ? 'allow_once' : 'reject_once'
    const option = permission.request.options.find(value => value.kind === kind)
    permission.settle(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } })
    this.changed()
  }
  private denyPermission(): void { this.permission?.settle({ outcome: { outcome: 'cancelled' } }); this.permission = undefined }

  readonly clientHandlers: Required<AcpEventHandlers> = {
    onStream: (sessionId, frame) => {
      if (this.closing || !this.active || sessionId !== this.currentId || this.state !== 'busy') return
      if (frame.type === 'start') { this.liveAttempt = frame.attemptId; this.live.clear() }
      else if (frame.type === 'chunk' && frame.attemptId === this.liveAttempt) {
        const chunk = frame.chunk
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const kind = chunk.type === 'text-delta' ? 'assistant' : 'thought'
          const block = this.live.get(chunk.index) ?? { kind, text: '' }
          block.text += chunk.text; this.live.set(chunk.index, block)
        }
      }
      this.changed()
    },
    onUpdate: (sessionId, update) => {
      if (this.closing || !this.active || sessionId !== this.currentId || this.state === 'idle') return
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk': {
          const kind = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'thought'
          for (const [index, block] of this.live) if (block.kind === kind) this.live.delete(index)
          if (update.content.type === 'text') void this.record(kind, update.content.text)
          else if (update.content.type === 'resource_link') void this.record(kind, `${update.content.name}: ${update.content.uri}`)
          break
        }
        case 'tool_call':
          void this.record('tool', update.title, { toolCallId: update.toolCallId, toolStatus: 'in_progress' })
          break
        case 'tool_call_update': {
          const text = update.content?.map(item => item.type === 'content' && item.content.type === 'text' ? item.content.text : '').filter(Boolean).join('\n') ?? ''
          const toolStatus = update.status === 'failed' ? 'failed' : update.status === 'completed' ? 'completed' : 'in_progress'
          void this.record('tool_result', text || toolStatus, { toolCallId: update.toolCallId, toolStatus })
          break
        }
        case 'usage_update': void this.record('usage', `${update.used}/${update.size} tokens`); break
      }
    },
    onRequestPermission: (sessionId, request, settle) => {
      if (this.closing || !this.active || sessionId !== this.currentId || this.state !== 'busy' || this.permission) {
        settle({ outcome: { outcome: 'cancelled' } }); return
      }
      this.permission = { id: randomUUID(), title: request.toolCall.title ?? 'Tool permission', request, settle }
      this.changed()
    },
    onDisconnect: reason => {
      if (this.closing) return
      this.denyPermission(); this.promptAbort?.abort()
      this.showError(`Disconnected: ${reason}`)
    },
  }

  close(): Promise<void> { return this.closePromise ??= this.doClose() }
  private async doClose(): Promise<void> {
    this.closing = true; this.active = false; this.abortTransition?.(); this.denyPermission()
    try {
      await this.stopPrompt()
      await this.writes
      await this.saveDraftNow()
      if (this.currentId && this.client.connected) await this.client.closeSession(this.currentId)
    } finally { this.listeners.clear() }
  }
}
