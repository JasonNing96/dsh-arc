/** Optional execution owner. TUI imports only the public session-driver contract. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { SESSION_EXECUTION_API_VERSION, type SessionExecutionDriver, type SessionExecutionEvent,
  type TuiSessionExecutionRegistry, type SessionExecutionSnapshot, type SessionExecutionRow, type SessionExecutionCommandOutcome } from '@deepseek-harness-tui/dsh-tui/session-execution'
import { ArcController, type Connector } from '../../../tui/src/arc-controller.js'
import { ArcRuntimeSession } from '../../../tui/src/arc-runtime-session.js'
import { resolveRuntimeConfig, type RuntimeConfig } from '../../../tui/src/runtime-config.js'
import { loadRemoteConfig, type RemoteConfig } from '../../../tui/src/remote-config.js'

export const name = 'arc-execution'
export const inject = ['tuiSessionExecution', 'tuiShortcuts']
export interface Config {
  readonly local: { readonly cwd: string; readonly dshHome: string; readonly stateDir: string; readonly dshExecutable: string; readonly arcProfile: string }
  readonly remoteConfig?: string
  readonly fresh?: boolean
  readonly switchShortcut?: string
  readonly reconnectShortcut?: string
}
interface ShortcutPort {
  register(combo: string, options: { description: string; handler: () => Promise<void> }, identity: Context): () => void
  list(): readonly { combo: string; description: string }[]
}
class Ready extends Service { constructor(ctx: Context) { super(ctx, 'arcExecutionReady') } }

/** The same driver is exercised with deterministic ACP transports in acceptance. */
export class ArcExecutionDriver implements SessionExecutionDriver {
  readonly id = 'arc'
  readonly capabilities: SessionExecutionDriver['capabilities'] = new Set(['submit', 'cancel', 'permission-reply', 'commands', 'draft'])
  readonly commands = [{ name: 'arc', description: 'ARC status | switch | reconnect' }]
  private readonly controller: ArcController<ArcRuntimeSession>
  private readonly listeners = new Set<(event: SessionExecutionEvent) => void>()
  private activeTurn: string | undefined
  private generation = 0
  private lastPermission: string | undefined
  private closed = false
  private closePromise: Promise<void> | undefined
  private draftTimer: ReturnType<typeof setTimeout> | undefined

  constructor(config: RuntimeConfig, remote: RemoteConfig | undefined, connector?: Connector) {
    this.controller = new ArcController(config, remote, (client, store, options) => new ArcRuntimeSession(client, store, options), connector)
    this.controller.onChange(() => this.changed())
  }
  async start(fresh = false): Promise<void> { await this.controller.start(fresh) }
  private emit(event: SessionExecutionEvent): void { if (!this.closed) for (const listener of this.listeners) listener(event) }
  private changed(): void {
    if (this.closed || !this.controller.activeSession?.sessionId) return
    const snapshot = this.snapshot()
    const turnId = this.activeTurn
    if (turnId !== undefined) {
      this.emit({ type: 'snapshot', turnId, snapshot })
      const permission = this.controller.activeSession.pendingPermission
      if (permission && permission.id !== this.lastPermission) {
        this.lastPermission = permission.id
        this.emit({ type: 'permission', turnId, requestId: permission.id, title: permission.title })
      }
      if (!snapshot.working) this.activeTurn = undefined
    } else this.emit({ type: 'session', generation: ++this.generation, snapshot })
  }
  snapshot(): SessionExecutionSnapshot {
    const session = this.controller.activeSession
    if (!session?.sessionId || !session.conversation) throw new Error('ARC session is not ready')
    const rows: SessionExecutionRow[] = []
    for (const entry of session.transcript) {
      if (entry.kind === 'tool_result') {
        const index = rows.findLastIndex(row => row.tool?.callId === entry.toolCallId)
        const prior = rows[index]
        if (prior?.tool) {
          rows[index] = { ...prior, tool: { ...prior.tool, status: entry.toolStatus === 'failed' ? 'error' : entry.toolStatus === 'completed' ? 'ok' : 'running', resultText: entry.text } }
          continue
        }
      }
      const kind = entry.kind === 'thought' ? 'reasoning' : ['user', 'assistant', 'tool'].includes(entry.kind) ? entry.kind as 'user' | 'assistant' | 'tool' : 'notice'
      rows.push({ id: entry.seq, kind, text: entry.text, time: entry.time,
        ...(entry.kind !== 'tool' ? {} : { tool: { callId: entry.toolCallId ?? String(entry.seq), name: entry.text, status: 'running' as const } }),
      })
    }
    let nextId = (session.transcript.at(-1)?.seq ?? -1) + 1
    for (const preview of session.preview) rows.push({ id: nextId++, kind: preview.kind === 'thought' ? 'reasoning' : 'assistant', text: preview.text, time: Date.now(), streaming: true })
    if (session.errorText || session.unsavedWarning || session.transitionText) rows.push({ id: nextId, kind: 'notice', text: [session.errorText, session.unsavedWarning, session.transitionText].filter(Boolean).join('\n'), time: Date.now() })
    return { uiSessionId: session.conversation, executionSessionId: session.sessionId,
      title: `ARC ${this.controller.currentLocation.toUpperCase()} · Home ${this.controller.home.toUpperCase()}${this.controller.connected ? '' : ' · DISCONNECTED'}`,
      working: this.controller.switching || session.running !== 'idle', rows, cwd: session.config.cwd, model: this.controller.model, draft: session.uiState.buffer }
  }
  subscribe(listener: (event: SessionExecutionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  submit(text: string, turnId: string): boolean {
    if (this.closed || this.activeTurn || this.controller.switching) return false
    this.activeTurn = turnId
    if (this.controller.activeSession?.submit(text)) return true
    this.activeTurn = undefined
    return false
  }
  async cancel(): Promise<void> {
    if (this.controller.switching) {
      const transition = this.controller.switchRuntime()
      this.controller.cancelTransition()
      await transition
    }
    else await this.controller.activeSession?.cancel()
  }
  async replyPermission(requestId: string, outcome: 'allow' | 'deny'): Promise<void> {
    this.controller.activeSession?.replyPermission(requestId, outcome)
  }
  updateDraft(text: string): void {
    if (this.closed) return
    const session = this.controller.activeSession
    session?.restoreInput({ buffer: text, cursor: text.length })
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined
      void session?.saveDraftNow().catch(error => session.showError(String(error)))
    }, 150)
  }
  async command(name: string, rawInput: string): Promise<SessionExecutionCommandOutcome | undefined> {
    if (name !== 'arc' || this.closed) return undefined
    const action = rawInput.trim() || 'status'
    if (action === 'status') {
      const snapshot = this.snapshot()
      return { kind: 'success', text: `${snapshot.title}\nConversation: ${snapshot.uiSessionId}\nSession: ${snapshot.executionSessionId}\nWorkspace: ${snapshot.cwd}`, consumeDraft: true }
    }
    if (action !== 'switch' && action !== 'reconnect') return { kind: 'error', text: 'Usage: /arc status | /arc switch | /arc reconnect', consumeDraft: false }
    const transition = this.controller.switchRuntime(action === 'reconnect')
    this.changed()
    const ok = await transition
    return ok ? { kind: 'success', text: this.snapshot().title, consumeDraft: true }
      : { kind: 'error', text: this.controller.activeSession?.errorText || 'ARC handoff was not accepted', consumeDraft: false }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.listeners.clear()
    return this.closePromise = this.controller.close()
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (SESSION_EXECUTION_API_VERSION !== 1) throw new Error('ARC requires session execution API v1')
  if (!config?.local || ['cwd', 'dshHome', 'stateDir', 'dshExecutable', 'arcProfile'].some(key => typeof config.local[key as keyof Config['local']] !== 'string' || !config.local[key as keyof Config['local']].trim())) {
    throw new Error('Configure ARC local cwd, dshHome, stateDir, dshExecutable and arcProfile explicitly')
  }
  const local = resolveRuntimeConfig({ ...config.local, demo: false })
  const remote = config.remoteConfig === undefined ? undefined : await loadRemoteConfig(config.remoteConfig)
  if (remote && !remote.arcProfile) throw new Error('Remote ARC runtime requires an explicit arcProfile')
  const driver = new ArcExecutionDriver(local, remote)
  // The registry owns cleanup before connecting, including interrupted startup.
  const registry = ctx.get('tuiSessionExecution') as TuiSessionExecutionRegistry
  registry.register(ctx, driver)
  await driver.start(config.fresh)
  const shortcuts = ctx.get('tuiShortcuts') as ShortcutPort
  for (const [combo, action] of [[config.switchShortcut ?? 'alt+x', 'switch'], [config.reconnectShortcut ?? 'alt+g', 'reconnect']]) {
    if (!combo) continue
    shortcuts.register(combo, { description: `ARC ${action}`, handler: async () => {
      const outcome = await driver.command('arc', action!)
      if (outcome?.kind === 'error') throw new Error(outcome.text)
    } }, ctx)
    if (!shortcuts.list().some(binding => binding.combo === combo && binding.description === `ARC ${action}`)) {
      ctx.logger.warn(`ARC shortcut ${combo} was refused; use /arc ${action}`)
    }
  }
  new Ready(ctx)
}
