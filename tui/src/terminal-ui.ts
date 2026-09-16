import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
/**
 * Terminal user interface for one runtime connection.
 *
 * Renders a bounded transcript, a status line, and a grapheme-safe input
 * editor. Asynchronous runtime output updates the transcript but never the
 * input buffer, so typing during output is never lost. Overlay states
 * (session picker, permission prompt) capture keys while active.
 *
 * @module personal-dsh-tui/terminal-ui
 */

import type { AcpClient, AcpError, SessionListEntry } from './acp-client.js'
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'
import type { StateStore, TranscriptEntry } from './state-store.js'
import type { ArcConversationMirror } from './arc-session-port.js'
import { codePoints, displayWidth, graphemes, insertAt, deleteOne, KeyDecoder } from './line-editor.js'

/** Which overlay, if any, currently captures keys. */
type Overlay = 'none' | 'sessions' | 'permission'

/** What the runtime is doing for the current session. */
type RunState = 'idle' | 'busy' | 'cancelling'

/** A pending permission decision routed through the overlay. */
interface PendingPermission {
  readonly sessionId: string
  readonly request: RequestPermissionRequest
  /** Semantic choices extracted from the request's option kinds. */
  readonly allowOptionId: string | undefined
  readonly rejectOptionId: string | undefined
  settle: (response: RequestPermissionResponse) => void
}

interface PickerEntry {
  readonly sessionId: string
  readonly label: string
  readonly hasMirror: boolean
}

const MAX_VISIBLE_ENTRIES = 500
const INPUT_HISTORY_LIMIT = 100
const TRANSCRIPT_ROWS = 20
const DRAFT_DEBOUNCE_MS = 800

/** One line of rendered transcript (display and tests). */
export interface DisplayLine {
  readonly text: string
  readonly kind: TranscriptEntry['kind'] | 'input'
}

/**
 * Interactive TUI session driver.
 *
 * Keys are processed through a serialized async chain (edits stay in order)
 * without blocking new input from being decoded; cancellation and quit remain
 * responsive while a prompt is in flight.
 */
export class TerminalUi {
  private redrawDepth = 0
  private redrawPending = false
  private active = true
  private transitionText = ''
  private cancelTransition: (() => void) | undefined
  private buffer = ''
  private cursor = 0
  private runState: RunState = 'idle'
  private overlay: Overlay = 'none'
  private overlayCursor = 0
  private pickerEntries: PickerEntry[] = []
  private permission: PendingPermission | undefined
  private permissionScroll = 0
  private readonly inputHistory: string[] = []
  private historyIndex = -1
  private historyDraft = ''
  private scrollOffset = 0
  private following = true
  private entries: TranscriptEntry[] = []
  private liveAttempt: string | undefined
  private liveBlocks = new Map<number, { kind: 'assistant' | 'thought'; text: string }>()
  private streamTimer: NodeJS.Timeout | undefined
  private conversationId: string | undefined

  get conversation(): string | undefined { return this.conversationId ?? this.currentSessionId }

  /** Export a renderer-neutral handoff mirror, preferring durable state. */
  async exportConversationMirror(): Promise<ArcConversationMirror> {
    const mirror = this.currentSessionId === undefined ? null : await this.store.loadMirror(this.currentSessionId)
    return {
      entries: [...(mirror?.entries ?? this.entries)],
      createdAt: mirror?.createdAt ?? Date.now(),
      conversationId: this.conversation ?? mirror?.conversationId ?? this.currentSessionId ?? '',
      input: this.uiState,
    }
  }

  /** Persist the inherited mirror before publishing the target endpoint. */
  async adoptConversation(sessionId: string, source: ArcConversationMirror): Promise<void> {
    const entries = [...source.entries]
    entries.push({ seq: entries.length, time: Date.now(), kind: 'status', text: `已切换到 ${this.config.location} · 文件仍属于各自设备` })
    await this.store.writeMirror({ sessionId, cwd: this.config.cwd, createdAt: source.createdAt,
      updatedAt: Date.now(), entries, resumedAt: null, conversationId: source.conversationId || sessionId })
    await this.store.saveDraft(sessionId, source.input.buffer)
    this.currentSessionId = sessionId
    this.conversationId = source.conversationId || sessionId
    this.entries = entries.slice(-MAX_VISIBLE_ENTRIES)
    this.restoreInput(source.input)
    this.overlay = 'none'
    this.scrollOffset = 0
    this.following = true
    this.lastError = ''
  }

  private onStream(sessionId: string, frame: AssistantStreamFrame): void {
    if (sessionId !== this.currentSessionId) return
    if (frame.type === 'start') {
      this.finishStream(true)
      this.liveAttempt = frame.attemptId
    } else if (this.liveAttempt === frame.attemptId && frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const block = this.liveBlocks.get(chunk.index) ?? { kind: chunk.type === 'text-delta' ? 'assistant' : 'thought', text: '' }
        block.text += chunk.text
        this.liveBlocks.set(chunk.index, block)
      }
    } else if (this.liveAttempt === frame.attemptId && frame.type === 'end') {
      this.finishStream(true)
    }
    if (this.streamTimer === undefined) this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined
      if (!this.quitRequested) this.requestRedraw()
    }, 32)
  }

  /** Committed ACP messages replace transient text; loss keeps a marked prefix. */
  private finishStream(interrupted: boolean): void {
    if (this.streamTimer !== undefined) clearTimeout(this.streamTimer)
    this.streamTimer = undefined
    if (interrupted) for (const block of this.liveBlocks.values()) {
      if (block.text) void this.record(block.kind, `[未完成输出] ${block.text}`)
    }
    this.liveBlocks.clear()
    this.liveAttempt = undefined
  }
  private quitRequested = false
  private pendingPrompt: AbortController | undefined
  private cancelRequested = false
  private promptSent = false
  private currentSessionId: string | undefined
  private lastError = ''
  private transcriptClosed = false
  private ctrlCArmed = false
  private keyChain: Promise<void> = Promise.resolve()
  private escapeTimer: NodeJS.Timeout | undefined
  private draftTimer: NodeJS.Timeout | undefined
  private lastUnsavedError = ''
  private readonly decoder = new KeyDecoder()
  private rows = 24
  private cols = 80

  constructor(
    private readonly client: AcpClient,
    private readonly store: StateStore,
    private readonly config: { cwd: string; mode: 'dsh' | 'demo'; location?: string; remote?: boolean; onSwitch?: () => void; onReconnect?: () => void },
    private readonly write: (text: string) => void,
  ) {}

  restoreInput(state: { buffer: string; cursor: number }): void { this.buffer = state.buffer; this.cursor = state.cursor }
  setActive(active: boolean): void { this.active = active }
  setTransition(text: string, cancel?: () => void): void {
    this.transitionText = text
    this.cancelTransition = cancel
    this.requestRedraw()
  }
  showError(text: string): void { this.lastError = text; this.requestRedraw() }
  get inputComplete(): boolean { return !this.decoder.hasPendingBytes }
  async flushInput(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 15_000
    for (;;) {
      signal?.throwIfAborted()
      await this.keyChain
      if (this.inputComplete) return
      if (Date.now() >= deadline) throw new Error('输入序列或粘贴尚未结束，投切已取消；内容保留在原端')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** Client event handlers bridged into UI state (used by cli.ts and tests). */
  readonly clientHandlers = {
    onStream: (sessionId: string, frame: AssistantStreamFrame): void => this.onStream(sessionId, frame),
    onUpdate: (sessionId: string, update: SessionNotification['update']): void => {
      this.handleUpdate(sessionId, update)
    },
    onRequestPermission: (
      sessionId: string,
      request: RequestPermissionRequest,
      settle: (response: RequestPermissionResponse) => void,
    ): void => {
      if (!this.active || this.quitRequested || sessionId !== this.currentSessionId || this.permission !== undefined) {
        settle({ outcome: { outcome: 'cancelled' } })
        return
      }
      const allow = request.options.find(option => option.kind === 'allow_once')
      const reject = request.options.find(option => option.kind === 'reject_once')
      this.permission = {
        sessionId,
        request,
        allowOptionId: allow?.optionId,
        rejectOptionId: reject?.optionId,
        settle,
      }
      this.permissionScroll = 0
      this.overlay = 'permission'
      this.requestRedraw()
    },
    onDisconnect: (reason: string): void => {
      this.finishStream(true)
      this.lastError = `连接断开：${reason}`
      this.runState = 'idle'
      this.pendingPrompt?.abort()
      // Deny any permission still awaiting a decision.
      this.permission?.settle({ outcome: { outcome: 'cancelled' } })
      this.permission = undefined
      if (this.overlay === 'permission') this.overlay = 'none'
      this.requestRedraw()
    },
  }

  /** Whether the UI loop should exit. */
  get shouldQuit(): boolean {
    return this.quitRequested
  }

  /** Current input state (tests). */
  get uiState(): { buffer: string; cursor: number } {
    return { buffer: this.buffer, cursor: this.cursor }
  }

  /** Current run state (tests). */
  get running(): RunState {
    return this.runState
  }

  /** Active permission request, if any (tests). */
  get pendingPermission(): RequestPermissionRequest | undefined {
    return this.permission?.request
  }

  /** Last surfaced error text (tests). */
  get errorText(): string {
    return this.lastError
  }

  /** Rendered transcript lines (tests). */
  get displayLines(): DisplayLine[] {
    return this.entries.map(entry => ({ text: entry.text, kind: entry.kind }))
  }

  /** Neutral session projection consumed by alternate renderers. */
  get projectionEntries(): (TranscriptEntry & { streaming?: boolean })[] {
    return [...this.entries, ...[...this.liveBlocks.entries()].map(([index, block]) => ({
      seq: -1 - index, time: 0, kind: block.kind, text: block.text, streaming: true,
    }))]
  }

  get transitionNotice(): string { return this.transitionText }
  updateDraft(text: string): void {
    if (this.quitRequested || text === this.buffer) return
    this.buffer = text; this.cursor = graphemes(text).length
    this.scheduleDraftSave()
  }
  /** Same one-shot semantic decisions as the classic permission overlay. */
  decidePermission(choice: 'allow' | 'reject' | 'cancel'): void {
    this.handlePermissionKey(choice === 'cancel' ? { name: 'escape', text: '', ctrl: false, alt: false }
      : { name: 'char', text: choice === 'allow' ? 'y' : 'n', ctrl: false, alt: false })
    this.requestRedraw()
  }

  /** The session this UI is currently driving. */
  get sessionId(): string | undefined {
    return this.currentSessionId
  }

  /** Whether saved labels are truthful right now (tests). */
  get unsavedWarning(): string {
    return this.lastUnsavedError
  }

  /** Terminal size for bounded rendering (cli.ts and tests). */
  setSize(rows: number, cols: number): void {
    this.rows = Math.max(8, Math.min(rows, 200)) || 24
    this.cols = Math.max(20, cols) || 80
    this.requestRedraw()
  }

  /** Register an extra redraw hook (used by the main loop to poll quit). */
  onChange(hook: () => void): void {
    this.redrawHooks.add(hook)
  }

  private readonly redrawHooks = new Set<() => void>()

  private requestRedraw(): void {
    if (this.redrawDepth > 0) { this.redrawPending = true; return }
    for (const hook of this.redrawHooks) hook()
    this.render()
  }

  /** Create a new session in the runtime. Refuses while a prompt is running. */
  async createSession(): Promise<boolean> {
    if (this.runState !== 'idle') {
      this.lastError = '当前回合运行中，不能新建会话（先等待或 Ctrl+C 中断）'
      this.requestRedraw()
      return false
    }
    const initialDraft = this.currentSessionId === undefined ? this.buffer : ''
    try {
      await this.switchDraft()
      const sessionId = await this.client.newSession(this.config.cwd)
      if (this.currentSessionId !== undefined && this.currentSessionId !== sessionId) {
        await this.closeInactive(this.currentSessionId)
      }
      this.currentSessionId = sessionId
      this.conversationId = sessionId
      await this.store.writeMirror({
        sessionId,
        cwd: this.config.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entries: [],
        resumedAt: null,
      })
      this.entries = []
      this.scrollOffset = 0
      this.following = true
      this.buffer = initialDraft
      this.cursor = graphemes(initialDraft).length
      if (initialDraft) await this.saveDraftNow()
      this.lastError = ''
      this.requestRedraw()
      return true
    } catch (error) {
      this.lastError = `新建会话失败：${(error as AcpError).message}`
      this.requestRedraw()
      return false
    }
  }

  /**
   * Resume a persisted session through a genuine ACP resume, then re-display
   * this client's own mirror. Sessions without a mirror get a fresh mirror
   * explicitly marked history-unavailable (never a fabricated transcript).
   * Resume failure leaves the current session and draft usable.
   */
  async resumeSession(sessionId: string): Promise<boolean> {
    if (this.runState !== 'idle') {
      this.lastError = '当前回合运行中，不能切换会话（先等待或 Ctrl+C 中断）'
      this.requestRedraw()
      return false
    }
    const previousSession = this.currentSessionId
    const previousEntries = this.entries
    const previousBuffer = this.buffer
    try {
      await this.switchDraft()
      await this.client.resumeSession(sessionId, this.config.cwd)
    } catch (error) {
      const message = (error as AcpError).message
      await this.store.markUnresumable(sessionId, message).catch(() => undefined)
      this.lastError = `恢复失败：${message}`
      // Roll back to the previous usable state.
      this.currentSessionId = previousSession
      this.entries = previousEntries
      this.buffer = previousBuffer
      this.cursor = graphemes(this.buffer).length
      this.requestRedraw()
      return false
    }
    const mirror = await this.store.loadMirror(sessionId)
    this.conversationId = mirror?.conversationId ?? sessionId
    this.currentSessionId = sessionId
    if (mirror === null) {
      await this.store.writeMirror({
        sessionId,
        cwd: this.config.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entries: [],
        resumedAt: Date.now(),
        historyUnavailable: true,
      })
      this.entries = []
      await this.record('status', '已恢复外部会话：本客户端此前未记录，历史显示不可用，仅显示新内容')
    } else {
      this.entries = [...mirror.entries]
      await this.record('status', `已恢复会话（本地镜像 ${String(mirror.entries.length)} 条记录）`)
    }
    await this.store.markResumed(sessionId)
    if (previousSession !== undefined && previousSession !== sessionId) {
      await this.closeInactive(previousSession)
    }
    this.currentSessionId = sessionId
    this.buffer = await this.store.loadDraft(sessionId)
    this.cursor = graphemes(this.buffer).length
    this.scrollOffset = 0
    this.following = true
    this.lastError = ''
    this.requestRedraw()
    return true
  }

  /** Persist the draft of the session we are leaving. */
  private async switchDraft(): Promise<void> {
    if (this.draftTimer !== undefined) {
      clearTimeout(this.draftTimer)
      this.draftTimer = undefined
    }
    if (this.currentSessionId !== undefined) {
      await this.store.saveDraft(this.currentSessionId, this.buffer).catch((error: unknown) => {
        this.lastUnsavedError = `草稿保存失败：${errorTextOf(error)}`
      })
    }
  }

  /** Close a session we are no longer driving (DSH list excludes active). */
  private async closeInactive(sessionId: string): Promise<void> {
    if (!this.client.connected) return
    await this.client.closeSession(sessionId).catch(() => undefined)
  }

  /** Show the session-picker overlay (runtime list merged with mirrors). */
  async openSessionList(strict = false): Promise<void> {
    let listed: SessionListEntry[] = []
    try {
      listed = await this.client.listSessions(this.config.cwd)
    } catch (error) {
      if (strict) throw error
      this.lastError = `会话列表获取失败：${(error as AcpError).message}`
    }
    const mirrors = await this.store.listMirrors()
    // session/list deliberately excludes the currently active session; merge
    // our own so switching back is possible (selecting it is a no-op).
    const merged = new Map<string, SessionListEntry>()
    for (const entry of listed) merged.set(entry.sessionId, entry)
    if (this.currentSessionId !== undefined) {
      merged.set(this.currentSessionId, { sessionId: this.currentSessionId, cwd: this.config.cwd, title: null, updatedAt: null })
    }
    this.pickerEntries = [...merged.values()].slice(0, 20).map(entry => {
      const mirror = mirrors.find(m => m.sessionId === entry.sessionId)
      return {
        sessionId: entry.sessionId,
        hasMirror: mirror !== undefined,
        label: `${entry.sessionId.slice(0, 8)} ${entry.title ?? mirror?.entries.find(item => item.kind === 'user')?.text ?? '新会话'} · ${mirror !== undefined ? `镜像${String(mirror.entries.length)}条` : '无镜像·历史不可用'}`,
      }
    })
    this.overlay = 'sessions'
    // Cursor starts at the first non-active entry when possible.
    const activeIndex = this.pickerEntries.findIndex(entry => entry.sessionId === this.currentSessionId)
    this.overlayCursor = activeIndex === -1 ? 0 : (activeIndex + 1) % Math.max(this.pickerEntries.length, 1)
    this.requestRedraw()
  }

  /** Submit the current buffer as one prompt. */
  async submit(): Promise<void> {
    if (!this.active || this.transitionText) return
    if (!this.client.connected) { this.showError('连接已断开，草稿保留；Ctrl+G 重连后再发送'); return }
    const text = this.buffer
    if (text.trim().length === 0 || this.runState !== 'idle') return
    if (this.currentSessionId === undefined) { this.showError('请先 Ctrl+N 新建，或 Ctrl+S 选择目标端会话；输入保留'); return }
    this.buffer = ''
    this.cursor = 0
    this.historyIndex = -1
    this.inputHistory.push(text)
    if (this.inputHistory.length > INPUT_HISTORY_LIMIT) this.inputHistory.shift()
    // Reserve busy BEFORE any await so a second Enter cannot double-submit.
    this.runState = 'busy'
    this.cancelRequested = false
    this.promptSent = false
    // The submitted text replaces the draft on disk.
    await this.store.saveDraft(this.currentSessionId, '').catch((error: unknown) => {
      this.lastUnsavedError = `草稿清除失败：${errorTextOf(error)}`
    })
    await this.record('user', text)
    this.requestRedraw()
    const controller = new AbortController()
    this.pendingPrompt = controller
    const sessionId = this.currentSessionId
    try {
      if (this.cancelRequested || this.quitRequested) {
        await this.record('status', '回合结束：cancelled（尚未发送）')
        return
      }
      this.promptSent = true
      const response = await this.client.prompt(sessionId, text, controller.signal)
      await this.record('status', `回合结束：${response.stopReason}`)
    } catch (error) {
      const message = (error as AcpError).message
      await this.record('error', `发送失败：${message}`)
      this.lastError = message
    } finally {
      this.finishStream(true)
      this.pendingPrompt = undefined
      this.promptSent = false
      this.runState = 'idle'
      this.requestRedraw()
    }
  }

  /** Cancel the in-flight prompt of the current session. */
  async cancel(): Promise<void> {
    if (this.currentSessionId === undefined) return
    this.cancelRequested = true
    this.permission?.settle({ outcome: { outcome: 'cancelled' } })
    this.permission = undefined
    if (this.overlay === 'permission') this.overlay = 'none'
    if (this.runState === 'busy') this.runState = 'cancelling'
    this.requestRedraw()
    if (!this.promptSent) return
    try {
      await this.client.cancel(this.currentSessionId)
    } catch (error) {
      await this.record('error', `取消失败：${(error as AcpError).message}`)
    }
  }

  /** Feed raw stdin bytes: decode, serialize handling, never drop input. */
  feed(chunk: Buffer): Promise<void> {
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    try {
      this.enqueueKeys(this.decoder.push(chunk))
      if (this.decoder.pendingEscape) {
        this.escapeTimer = setTimeout(() => {
          this.escapeTimer = undefined
          this.enqueueKeys(this.decoder.flushEscape())
        }, 80)
        this.escapeTimer.unref()
      }
    } catch (error) {
      this.lastError = errorTextOf(error)
      this.requestRedraw()
    }
    return this.keyChain
  }

  private enqueueKeys(events: import('./line-editor.js').KeyEvent[]): void {
    if (events.length === 0) return
    this.keyChain = this.keyChain.then(() => this.drain(events)).catch(error => {
      this.lastError = `按键处理错误：${errorTextOf(error)}`
      this.requestRedraw()
    })
  }

  private async drain(events: import('./line-editor.js').KeyEvent[]): Promise<void> {
    // One stdin chunk can contain hundreds of characters. Drawing for every
    // character fills a slow terminal's output buffer and stalls keyboard input.
    this.redrawDepth++
    try {
      for (const key of events) {
        if (this.quitRequested) return
        await this.handleKey(key)
      }
    } finally {
      this.redrawDepth--
      if (this.redrawPending && this.redrawDepth === 0) {
        this.redrawPending = false
        this.requestRedraw()
      }
    }
  }

  /** Process one decoded key event. */
  async handleKey(key: import('./line-editor.js').KeyEvent): Promise<void> {
    if (!this.active) return
    if (this.transitionText) {
      if (key.name === 'ctrl-c') { this.cancelTransition?.(); return }
      if (!['char', 'paste', 'backspace', 'delete', 'left', 'right', 'home', 'end', 'newline'].includes(key.name)) return
    } else if (key.name === 'ctrl-r' || key.name === 'ctrl-g') {
      if (key.name === 'ctrl-r') this.config.onSwitch?.()
      else this.config.onReconnect?.()
      return
    }
    if (this.overlay === 'permission' && this.permission !== undefined) {
      this.handlePermissionKey(key)
      this.requestRedraw()
      return
    }
    if (this.overlay === 'sessions' && !this.transitionText) {
      await this.handlePickerKey(key)
      this.requestRedraw()
      return
    }
    let edited = false
    switch (key.name) {
      case 'ctrl-c': {
        // Ctrl+C cancels a running prompt; idle double-press quits.
        if (this.runState !== 'idle') {
          void this.cancel()
        } else if (this.ctrlCArmed) {
          await this.quit()
        } else {
          this.ctrlCArmed = true
          this.lastError = '再按一次 Ctrl+C 退出'
          this.requestRedraw()
          setTimeout(() => {
            if (this.quitRequested) return
            this.ctrlCArmed = false
            this.requestRedraw()
          }, 2000).unref()
        }
        return
      }
      case 'ctrl-d': {
        if (this.buffer.length === 0) await this.quit()
        return
      }
      case 'ctrl-l': {
        this.entries = this.entries.slice(-50)
        edited = true
        break
      }
      case 'ctrl-s': {
        await this.openSessionList()
        return
      }
      case 'ctrl-n': {
        await this.createSession()
        return
      }
      case 'enter': {
        void this.submit().catch(error => { this.lastError = errorTextOf(error); this.requestRedraw() })
        return
      }
      case 'alt-enter': {
        void this.submit().catch(error => { this.lastError = errorTextOf(error); this.requestRedraw() })
        return
      }
      case 'newline': {
        // Ctrl+J: explicit multiline input.
        this.applyEdit(insertAt(this.buffer, this.cursor, '\n'))
        edited = true
        break
      }
      case 'backspace': {
        this.applyEdit(deleteOne(this.buffer, this.cursor, 'back'))
        edited = true
        break
      }
      case 'delete': {
        this.applyEdit(deleteOne(this.buffer, this.cursor, 'forward'))
        edited = true
        break
      }
      case 'left': {
        this.cursor = Math.max(0, this.cursor - 1)
        edited = true
        break
      }
      case 'right': {
        this.cursor = Math.min(graphemes(this.buffer).length, this.cursor + 1)
        edited = true
        break
      }
      case 'home': {
        this.cursor = 0
        edited = true
        break
      }
      case 'end': {
        this.cursor = graphemes(this.buffer).length
        edited = true
        break
      }
      case 'up': {
        if (this.buffer.includes('\n')) {
          this.cursor = lineUp(this.buffer, this.cursor)
        } else {
          this.recallHistory(-1)
        }
        edited = true
        break
      }
      case 'down': {
        if (this.buffer.includes('\n')) {
          this.cursor = lineDown(this.buffer, this.cursor)
        } else {
          this.recallHistory(1)
        }
        edited = true
        break
      }
      case 'pageup': {
        this.following = false
        this.scrollOffset = Math.min(this.scrollOffset + this.rows, Math.max(this.transcriptRows().length - 1, 0))
        this.requestRedraw()
        return
      }
      case 'pagedown': {
        this.scrollOffset = Math.max(this.scrollOffset - this.rows, 0)
        if (this.scrollOffset === 0) this.following = true
        this.requestRedraw()
        return
      }
      case 'escape': {
        this.lastError = ''
        edited = true
        break
      }
      case 'char': {
        this.applyEdit(insertAt(this.buffer, this.cursor, key.text))
        edited = true
        break
      }
      case 'paste': {
        // Bracketed paste inserts verbatim and never submits.
        this.applyEdit(insertAt(this.buffer, this.cursor, key.text))
        edited = true
        break
      }
      default:
        return
    }
    if (edited) {
      // New output while inspecting history must not yank the view back.
      if (this.following) this.scrollOffset = 0
      this.scheduleDraftSave()
      this.requestRedraw()
    }
  }

  /** Permission overlay: y allows, n denies, Esc/Ctrl+C denies. */
  private handlePermissionKey(key: import('./line-editor.js').KeyEvent): void {
    const pending = this.permission
    if (pending === undefined) {
      this.overlay = 'none'
      return
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.permissionScroll = Math.max(0, this.permissionScroll + (key.name === 'pageup' ? -1 : 1) * Math.max(1, this.rows - 8))
      return
    }
    const decide = (response: RequestPermissionResponse): void => {
      pending.settle(response)
      if (this.permission === pending) {
        this.permission = undefined
        if (this.overlay === 'permission') this.overlay = 'none'
      }
    }
    if (key.name === 'char' && key.text === 'y' && pending.allowOptionId !== undefined) {
      decide({ outcome: { outcome: 'selected', optionId: pending.allowOptionId } })
    } else if (key.name === 'char' && key.text === 'n' && pending.rejectOptionId !== undefined) {
      decide({ outcome: { outcome: 'selected', optionId: pending.rejectOptionId } })
    } else if (key.name === 'escape' || (key.name === 'ctrl-c' && key.ctrl)) {
      decide({ outcome: { outcome: 'cancelled' } })
    }
    // Unrecognized keys keep the overlay; nothing ever maps to approval.
  }

  private async handlePickerKey(key: import('./line-editor.js').KeyEvent): Promise<void> {
    if (key.name === 'ctrl-n') {
      this.overlay = 'none'
      await this.createSession()
      return
    }
    if (key.name === 'escape') {
      this.overlay = 'none'
      return
    }
    if (key.name === 'up') {
      this.overlayCursor = Math.max(0, this.overlayCursor - 1)
      return
    }
    if (key.name === 'down') {
      this.overlayCursor = Math.min(Math.max(this.pickerEntries.length - 1, 0), this.overlayCursor + 1)
      return
    }
    if (key.name === 'enter') {
      const entry = this.pickerEntries[this.overlayCursor]
      this.overlay = 'none'
      // Full session id retained from the picker entry, never a label parse.
      if (entry !== undefined) {
        if (entry.sessionId === this.currentSessionId) {
          this.lastError = '该会话已是当前会话'
          this.requestRedraw()
          return
        }
        await this.resumeSession(entry.sessionId)
      }
    }
  }

  /** Apply one edit result and remember it changed. */
  private applyEdit(edit: { buffer: string; cursor: number }): void {
    this.buffer = edit.buffer
    this.cursor = edit.cursor
  }

  private recallHistory(direction: -1 | 1): void {
    if (this.inputHistory.length === 0) return
    if (this.historyIndex === -1 && direction === -1) {
      this.historyDraft = this.buffer
      this.historyIndex = this.inputHistory.length
    }
    const next = this.historyIndex + direction
    if (next < 0) return
    if (next >= this.inputHistory.length) {
      this.historyIndex = -1
      this.buffer = this.historyDraft
    } else {
      this.historyIndex = next
      this.buffer = this.inputHistory[next] ?? ''
    }
    this.cursor = graphemes(this.buffer).length
  }

  /** Debounced draft persistence during editing. */
  private scheduleDraftSave(): void {
    if (this.draftTimer !== undefined) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined
      const sessionId = this.currentSessionId
      if (sessionId === undefined || this.quitRequested) return
      void this.store.saveDraft(sessionId, this.buffer).then(
        () => { this.lastUnsavedError = '' },
        (error: unknown) => { this.lastUnsavedError = `草稿未保存：${errorTextOf(error)}`; this.requestRedraw() },
      )
    }, DRAFT_DEBOUNCE_MS)
  }

  /** Record one transcript entry to the mirror and in-memory view. */
  private async record(kind: TranscriptEntry['kind'], text: string, extra?: Partial<TranscriptEntry>): Promise<void> {
    if (this.currentSessionId === undefined) return
    const entry: TranscriptEntry = { seq: this.entries.length, time: Date.now(), kind, text, ...extra }
    this.entries.push(entry)
    if (this.entries.length > MAX_VISIBLE_ENTRIES) {
      this.entries = this.entries.slice(-MAX_VISIBLE_ENTRIES)
    }
    if (this.transcriptClosed) return
    try {
      await this.store.append(this.currentSessionId, this.config.cwd, { kind, text, ...extra })
      this.lastUnsavedError = ''
    } catch (error) {
      this.lastUnsavedError = `记录未落盘（显示保留）：${errorTextOf(error)}`
    }
  }

  /** Bridge one session/update notification into the transcript. */
  private handleUpdate(sessionId: string, update: SessionNotification['update']): void {
    if (sessionId !== this.currentSessionId) {
      // Events for a session we already left never enter the new mirror.
      return
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        this.finishStream(false)
        if (update.content.type === 'text') void this.record('assistant', update.content.text)
        else if (update.content.type === 'resource_link') {
          void this.record('assistant', `[链接] ${update.content.name}: ${update.content.uri}`)
        }
        break
      }
      case 'agent_thought_chunk': {
        this.finishStream(false)
        if (update.content.type === 'text') void this.record('thought', update.content.text)
        break
      }
      case 'tool_call': {
        void this.record('tool', update.title, { toolCallId: update.toolCallId, toolStatus: 'in_progress' })
        break
      }
      case 'tool_call_update': {
        const status = update.status === 'failed' ? 'failed' : update.status === 'completed' ? 'completed' : 'in_progress'
        const detail = update.content
          ?.map(item => item.type === 'content' && item.content.type === 'text' ? item.content.text : '')
          .filter(text => text.length > 0)
          .join(' ')
        void this.record('tool_result', detail === undefined || detail.length === 0 ? `（${status}）` : detail, {
          toolCallId: update.toolCallId,
          toolStatus: status,
        })
        break
      }
      case 'usage_update': {
        void this.record('usage', `上下文 ${String(update.used)}/${String(update.size)} tokens`)
        break
      }
      default:
        break
    }
    this.requestRedraw()
  }

  /** Persist the current draft immediately (switch/quit). */
  async saveDraftNow(): Promise<void> {
    if (this.draftTimer !== undefined) {
      clearTimeout(this.draftTimer)
      this.draftTimer = undefined
    }
    if (this.currentSessionId === undefined) return
    await this.store.saveDraft(this.currentSessionId, this.buffer).then(() => { this.lastUnsavedError = '' }, (error: unknown) => {
      this.lastUnsavedError = `草稿保存失败：${errorTextOf(error)}`
    })
  }

  close(): Promise<void> { return this.quit() }

  /** Clean quit: deny pending permission, save draft, close session. */
  async quit(): Promise<void> {
    if (this.quitRequested) return
    this.cancelTransition?.()
    this.quitRequested = true
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    this.cancelRequested = true
    this.permission?.settle({ outcome: { outcome: 'cancelled' } })
    this.permission = undefined
    if (this.overlay === 'permission') this.overlay = 'none'
    this.transcriptClosed = true
    await this.saveDraftNow()
    if (this.currentSessionId !== undefined && this.client.connected) {
      await this.client.closeSession(this.currentSessionId).catch(() => undefined)
    }
    this.requestRedraw()
  }

  private transcriptRows(): string[] {
    const live = [...this.liveBlocks.values()].map(block => ({ ...block, toolStatus: undefined }))
    return [...this.entries, ...live].flatMap(entry => {
      const prefix = prefixFor(entry.kind, entry.toolStatus)
      return wrapText(entry.text, Math.max(this.cols - displayWidth(prefix) - 1, 4))
        .map(line => clampWidth(`${prefix}${line}`, this.cols - 1))
    })
  }

  /** Render within the actual terminal dimensions; the editor stays visible. */
  render(): void {
    const width = this.cols - 1 // Avoid the terminal's right-edge autowrap.
    const location = this.config.location ?? 'LOCAL'
    const badge = this.config.mode === 'demo' ? `${location} DEMO · 无模型` : `${location} · ${this.client.modelFor(this.currentSessionId)}`
    const runLabel = this.runState === 'busy' ? '运行中' : this.runState === 'cancelling' ? '取消中…' : '空闲'
    const header = [
      clampWidth(`DSH | ${badge} | ${this.client.connected ? runLabel : '已断开'}`, width),
      clampWidth(`工作区 ${this.config.cwd} · 会话 ${this.conversation?.slice(0, 8) ?? '未建立'}`, width),
    ]
    const footer: string[] = []
    if (this.transitionText) footer.push(clampWidth(this.transitionText, width))
    if (this.config.remote) footer.push(clampWidth('SSH 会话：断线后本轮可能中止；Ctrl+G 重连，检查后再继续', width))
    if (this.lastError) footer.push(clampWidth(this.lastError, width))
    if (this.lastUnsavedError) footer.push(clampWidth(this.lastUnsavedError, width))
    if (!this.following) footer.push(clampWidth('浏览历史 · PageDown 返回底部', width))
    if (this.overlay === 'permission' && this.permission !== undefined) {
      footer.push('── 权限请求 ──')
      footer.push(clampWidth('y 允许一次 · n 拒绝 · Esc 取消 · PageUp/Down 查看详情', width))
    } else if (this.overlay === 'sessions') {
      footer.push('── 会话列表 ──')
      const count = Math.max(1, Math.min(6, this.rows - 10))
      const start = Math.max(0, this.overlayCursor - count + 1)
      for (let index = start; index < Math.min(start + count, this.pickerEntries.length); index++) {
        footer.push(clampWidth(`${index === this.overlayCursor ? '>' : ' '} ${this.pickerEntries[index]?.label ?? ''}`, width))
      }
      footer.push(clampWidth('回车切换选中会话 · Ctrl+N 新建 · Esc 取消', width))
    }
    footer.push(...editorLines(this.buffer, this.cursor, width, Math.min(4, Math.max(1, this.rows - footer.length - 5))))
    footer.push(clampWidth('Enter 发送 · Ctrl+C 中断/退出 · Ctrl+S 会话 · Ctrl+R 投切 · Ctrl+G 重连', width))
    const boundedFooter = footer.slice(-(this.rows - header.length))
    const available = Math.max(0, this.rows - header.length - boundedFooter.length)
    const request = this.overlay === 'permission' ? this.permission?.request : undefined
    const transcript = request === undefined ? this.transcriptRows() : wrapText(
      `${request.toolCall.title ?? '工具权限'}\n${JSON.stringify(request.toolCall.rawInput ?? {}, null, 2)}`, width)
    if (request !== undefined) this.permissionScroll = Math.min(this.permissionScroll, Math.max(0, transcript.length - available))
    const end = request !== undefined ? Math.min(transcript.length, available + this.permissionScroll)
      : Math.max(0, transcript.length - (this.following ? 0 : this.scrollOffset))
    const visible = transcript.slice(Math.max(0, end - available), end)
    const padding = Array.from({ length: Math.max(0, available - visible.length) }, () => '')
    this.write(`\x1b[H${[...header, ...visible, ...padding, ...boundedFooter].map(line => `${line}\x1b[K`).join('\r\n')}\x1b[J`)
  }
}

function prefixFor(kind: TranscriptEntry['kind'], status?: string): string {
  switch (kind) {
    case 'user': return '你：'
    case 'assistant': return ''
    case 'thought': return '思考：'
    case 'tool': return `工具[${status ?? '进行中'}]：`
    case 'tool_result': return `工具结果[${status ?? ''}]：`
    case 'usage': return 'ℹ '
    case 'status': return '· '
    case 'error': return '✗ '
    case 'permission': return '权限：'
    default: return ''
  }
}

/** ANSI CSI/OSC/control-byte stripper: model/tool output is never trusted. */
export function stripControlSequences(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\t/g, '    ')
}

/** Hard-wrap one logical line to `width` display columns, preserving content. */
function wrapText(text: string, width: number): string[] {
  const clean = stripControlSequences(text)
  if (clean.length === 0) return ['']
  const output: string[] = []
  let current = ''
  let currentWidth = 0
  for (const paragraph of clean.split('\n')) {
    for (const g of graphemes(paragraph)) {
      const w = displayWidth(g)
      if (currentWidth + w > width && current.length > 0) {
        output.push(current)
        current = ''
        currentWidth = 0
      }
      current += g
      currentWidth += w
    }
    output.push(current)
    current = ''
    currentWidth = 0
  }
  return output.length === 0 ? [''] : output
}

/** Truncate to width with an ellipsis when over. */
function clampWidth(text: string, width: number): string {
  const clean = stripControlSequences(text).replace(/\n/g, ' ')
  if (displayWidth(clean) <= width) return clean
  let out = ''
  let used = 0
  for (const g of graphemes(clean)) {
    const w = displayWidth(g)
    if (used + w > width - 1) break
    out += g
    used += w
  }
  return `${out}…`
}

function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Vertical movement uses grapheme indexes throughout, including newlines. */
function lineUp(buffer: string, cursor: number): number { return moveLine(buffer, cursor, -1) }
function lineDown(buffer: string, cursor: number): number { return moveLine(buffer, cursor, 1) }
function moveLine(buffer: string, cursor: number, direction: -1 | 1): number {
  const units = graphemes(buffer)
  const starts = [0]
  for (let index = 0; index < units.length; index++) if (units[index] === '\n') starts.push(index + 1)
  const current = starts.findLastIndex(start => start <= cursor)
  const next = current + direction
  if (next < 0 || next >= starts.length) return cursor
  const nextStart = starts[next] ?? 0
  const nextEnd = (starts[next + 1] ?? units.length + 1) - 1
  return Math.min(nextStart + cursor - (starts[current] ?? 0), nextEnd)
}

function editorLines(buffer: string, cursor: number, width: number, maxRows: number): string[] {
  const before = graphemes(buffer).slice(0, cursor).join('')
  const currentLine = before.split('\n').length - 1
  const column = graphemes(before.split('\n').at(-1) ?? '').length
  const lines = buffer.split('\n')
  const start = Math.max(0, Math.min(currentLine - Math.floor(maxRows / 2), lines.length - maxRows))
  return lines.slice(start, start + maxRows).map((line, offset) => {
    if (start + offset !== currentLine) return clampWidth(`| ${line}`, width)
    const units = graphemes(line)
    let left = units.slice(0, column).join('')
    let clipped = false
    while (displayWidth(left) > Math.max(2, width - 6)) {
      left = graphemes(left).slice(1).join('')
      clipped = true
    }
    return clampWidth(`> ${clipped ? '…' : ''}${left}▏${units.slice(column).join('')}`, width)
  })
}

export { codePoints }
