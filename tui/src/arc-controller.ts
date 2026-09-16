/** One conversation handed between independent runtimes at idle checkpoints. */
import { AcpClient, type AcpEventHandlers } from './acp-client.js'
import { runtimeIdentity, type RuntimeConfig } from './runtime-config.js'
import { remoteIdentity, type RemoteConfig } from './remote-config.js'
import { StateStore } from './state-store.js'
import type { ArcSession } from './arc-session-port.js'
import { atomicWrite, safeSegment } from './state-store.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Location = 'local' | 'remote'
export type Connector = (location: Location, id: string, handlers: AcpEventHandlers, signal: AbortSignal) => Promise<AcpClient>
/** Session factory has no terminal, input-byte or rendering dependency. */
export type SessionFactory<V extends ArcSession> = (client: AcpClient, store: StateStore,
  options: { cwd: string; mode: 'dsh' | 'demo'; location: string; remote: boolean; onSwitch: () => void; onReconnect: () => void }) => V
interface Endpoint<V extends ArcSession> { client: AcpClient; store: StateStore; ui: V }
interface ArcHead { version: 1; location: Location; sessionId: string; conversationId: string; home: Location }


export class ArcController<V extends ArcSession> {
  private readonly endpoints = new Map<Location, Endpoint<V>>()
  private location: Location = 'local'
  private transition: Promise<boolean> | undefined
  private controller: AbortController | undefined
  private closing = false
  private closePromise: Promise<void> | undefined
  private starting: Promise<void> | undefined
  private readonly retiredClients = new Set<AcpClient>()
  private readonly retiredStores = new Set<StateStore>()

  constructor(private readonly config: RuntimeConfig, private readonly remote: RemoteConfig | undefined,
    private readonly sessionFactory: SessionFactory<V>, private readonly connector?: Connector) {}

  get currentLocation(): Location { return this.location }
  get activeUi(): V | undefined { return this.endpoints.get(this.location)?.ui }
  get switching(): boolean { return this.transition !== undefined }
  get activeSession(): V | undefined { return this.activeUi }
  cancelTransition(): void { this.controller?.abort() }

  private indexStore: StateStore | undefined
  private head: ArcHead | undefined
  private headChain: Promise<void> = Promise.resolve()
  private headError = false
  private readonly changeHooks = new Set<() => void>()
  onChange(hook: () => void): () => void { this.changeHooks.add(hook); return () => this.changeHooks.delete(hook) }
  get connected(): boolean { return this.endpoints.get(this.location)?.client.connected ?? false }
  get model(): string { const e = this.endpoints.get(this.location); return e?.client.modelFor(e.ui.sessionId) ?? '未连接' }
  get home(): Location { return this.head?.home ?? 'local' }
  private changed(): void { for (const hook of this.changeHooks) hook() }
  private persistHead(endpoint: Endpoint<V>, location: Location): Promise<void> {
    if (!this.indexStore || !endpoint.ui.sessionId || !endpoint.ui.conversation) return Promise.resolve()
    const head: ArcHead = { version: 1, location, sessionId: endpoint.ui.sessionId,
      conversationId: endpoint.ui.conversation, home: this.head?.conversationId === endpoint.ui.conversation ? this.head.home : location }
    if (JSON.stringify(head) === JSON.stringify(this.head)) return this.headChain
    const path = join(this.indexStore.directory, 'active.json')
    const write = this.headChain.then(async () => { await atomicWrite(path, JSON.stringify(head)); this.head = head })
    this.headChain = write.catch(() => undefined)
    return write
  }
  start(fresh = false): Promise<void> {
    return this.starting ??= this.doStart(fresh)
  }
  private async doStart(fresh: boolean): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    // Container image/version is a launch detail; the persistent data directory owns its sessions.
    // Preserve the existing native scope so pre-container installations keep their indexes.
    const remoteScope = this.remote?.docker === undefined ? this.remote : {
      host: this.remote.host, cwd: this.remote.cwd, dockerDataDir: this.remote.docker.dataDir,
    }
    const scope = safeSegment(JSON.stringify([runtimeIdentity(this.config), this.config.cwd, remoteScope]))
    this.indexStore = await StateStore.open(this.config.stateDir, 'arc-' + scope)
    let saved: ArcHead | undefined
    if (!fresh) {
      try {
        const h = JSON.parse(await readFile(join(this.indexStore.directory, 'active.json'), 'utf8')) as ArcHead
        if (h?.version !== 1 || !['local', 'remote'].includes(h.location) || !['local', 'remote'].includes(h.home) ||
            typeof h.sessionId !== 'string' || !h.sessionId || typeof h.conversationId !== 'string') throw new Error('ARC 会话索引损坏，请保留文件并用 --new 新建会话')
        saved = h; this.head = h
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const location = saved?.location ?? 'local'
    const endpoint = await this.connect(location, controller.signal)
    if (this.closing) { await endpoint.client.dispose(); await endpoint.store.close(); throw new Error('启动已取消') }
    this.location = location; this.endpoints.set(location, endpoint)
    endpoint.ui.setActive(true)
    let aborting: Promise<string[]> | undefined
    const abort = (): void => { aborting = this.releaseResources(endpoint.client) }
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      controller.signal.throwIfAborted()
      if (!(saved ? await endpoint.ui.resumeSession(saved.sessionId) : await endpoint.ui.createSession())) throw new Error(endpoint.ui.errorText)
      controller.signal.throwIfAborted()
    } finally {
      controller.signal.removeEventListener('abort', abort)
      const failures = await aborting
      if (failures?.length) throw new Error(`启动取消清理失败：${failures.join('; ')}`)
    }
    // The head write is the startup commit, just as it is during handoff.
    await this.persistHead(endpoint, location)
    this.controller = undefined; this.changed()
  }

  /** Ctrl+R switches; Ctrl+G reconnects this endpoint after transport loss. */
  switchRuntime(reconnect = false): Promise<boolean> {
    if (this.transition !== undefined) return this.transition
    const source = this.endpoints.get(this.location)
    if (source === undefined || this.closing) return Promise.resolve(false)
    if (source.ui.running !== 'idle' || source.ui.pendingPermission !== undefined) {
      source.ui.showError('当前回合运行中，请等待结束或 Ctrl+C 中断后再投切')
      return Promise.resolve(false)
    }
    if (reconnect && source.client.connected) {
      source.ui.showError('连接正常，无需重连')
      return Promise.resolve(false)
    }
    const target: Location = reconnect ? this.location : this.location === 'local' ? 'remote' : 'local'
    if (target === 'remote' && this.remote === undefined) {
      source.ui.showError('未配置服务器；请设置 --remote-config，或 ~/.local/share/personal-dsh/remote.json')
      return Promise.resolve(false)
    }
    const controller = new AbortController()
    this.controller = controller
    source.ui.setTransition(`正在连接${target === 'local' ? '本机' : this.remote?.host}；当前对话与草稿随投切保留，Ctrl+C 取消`, () => controller.abort())
    this.transition = this.performSwitch(source, target, reconnect, controller.signal).finally(() => {
      source.ui.setTransition('')
      this.controller = undefined
      this.transition = undefined
      this.changed()
    })
    return this.transition
  }

  private async performSwitch(source: Endpoint<V>, target: Location, reconnect: boolean, signal: AbortSignal): Promise<boolean> {
    let candidate: Endpoint<V> | undefined
    const previous = this.endpoints.get(target)
    let created = false
    let importedSession: string | undefined
    let aborting: Promise<string[]> | undefined
    const abort = (): void => { if (created && candidate) aborting = this.releaseResources(candidate.client) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await source.ui.saveDraftNow()
      if (source.ui.unsavedWarning) throw new Error(source.ui.unsavedWarning)
      signal.throwIfAborted()
      if (previous !== undefined) {
        await previous.ui.saveDraftNow()
        if (previous.ui.unsavedWarning) throw new Error(previous.ui.unsavedWarning)
      }
      candidate = await this.connect(target, signal, previous?.store)
      created = true
      const oldId = previous?.ui.sessionId
      if (reconnect && oldId !== undefined && !await candidate.ui.resumeSession(oldId)) throw new Error(candidate.ui.errorText)
      const current = candidate
      signal.throwIfAborted()
      if (!reconnect) {
        if (source.ui.sessionId === undefined) throw new Error('当前没有可投切的对话')
        const checkpoint = await source.client.exportCheckpoint(source.ui.sessionId)
        signal.throwIfAborted()
        importedSession = await current.client.newSession(current.client.workspaceCwd, checkpoint)
      }
      do {
        await source.ui.flushInput(signal)
        await source.ui.saveDraftNow()
      } while (!source.ui.inputComplete)
      if (source.ui.unsavedWarning) throw new Error(source.ui.unsavedWarning)
      signal.throwIfAborted()
      if (this.closing || !current.client.connected) throw new Error('目标连接已断开')
      if (importedSession !== undefined) {
        // Prepare on a fresh UI, so failure cannot replace a cached target's state.
        await current.ui.adoptConversation(importedSession, await source.ui.exportConversationMirror())
        do {
          await source.ui.flushInput(signal)
          await current.store.saveDraft(importedSession, source.ui.uiState.buffer)
        } while (!source.ui.inputComplete)
      }
      signal.throwIfAborted()
      if (!current.client.connected) throw new Error('目标连接已断开')
      current.ui.restoreInput(source.ui.uiState)
      // Enter the non-cancellable commit phase. A late Esc must not dispose
      // the candidate while its durable pointer is being written.
      signal.removeEventListener('abort', abort)
      await this.persistHead(current, target)
    } catch (error) {
      const cleanup = await aborting ?? []
      if (importedSession !== undefined && candidate?.client.connected) {
        try { await candidate.client.closeSession(importedSession) } catch (error) { cleanup.push(String(error)) }
      }
      if (created && candidate) cleanup.push(...await this.releaseResources(aborting ? undefined : candidate.client, previous ? undefined : candidate.store))
      const message = signal.aborted ? '投切已取消，仍在原端' : `投切失败，仍在原端：${error instanceof Error ? error.message : String(error)}`
      source.ui.showError(message + (cleanup.length ? `；资源清理失败：${cleanup.join('; ')}` : ''))
      return false
    } finally { signal.removeEventListener('abort', abort) }
    // The durable commit has succeeded. Rendering and retirement failures must
    // never enter the pre-commit rollback path or dispose this committed owner.
    source.ui.setActive(false)
    this.endpoints.set(target, candidate)
    this.location = target
    candidate.ui.setActive(true)
    this.changed()
    if (previous) {
      const failures = await this.releaseResources(previous.client)
      if (failures.length) candidate.ui.showError(`投切已完成；旧连接清理失败：${failures.join('; ')}`)
    }
    return true
  }

  /** Failed cleanup remains owned and is attempted again during shutdown. */
  private async releaseResources(client?: AcpClient, store?: StateStore): Promise<string[]> {
    const failures: string[] = []
    if (client) {
      this.retiredClients.add(client)
      try { await client.dispose(); this.retiredClients.delete(client) } catch (error) { failures.push(String(error)) }
    }
    if (store) {
      this.retiredStores.add(store)
      try { await store.close(); this.retiredStores.delete(store) } catch (error) { failures.push(String(error)) }
    }
    return failures
  }

  private async connect(location: Location, signal: AbortSignal, existingStore?: StateStore): Promise<Endpoint<V>> {
    const remote = location === 'remote' ? this.remote : undefined
    if (location === 'remote' && remote === undefined) throw new Error('服务器未配置')
    const id = remote === undefined ? runtimeIdentity(this.config) : remoteIdentity(remote)
    const store = existingStore ?? await StateStore.open(this.config.stateDir, id)
    let client: AcpClient | undefined
    let ui: V | undefined
    const handlers: AcpEventHandlers = {
      onStream: (sessionId, frame) => ui?.clientHandlers.onStream(sessionId, frame),
      onUpdate: (sessionId, update) => ui?.clientHandlers.onUpdate(sessionId, update),
      onDisconnect: reason => ui?.clientHandlers.onDisconnect(reason),
      onRequestPermission: (sessionId, request, settle) => {
        if (ui !== undefined) ui.clientHandlers.onRequestPermission(sessionId, request, settle)
        else settle({ outcome: { outcome: 'cancelled' } })
      },
    }
    try {
      if (this.connector !== undefined) client = await this.connector(location, id, handlers, signal)
      else if (remote !== undefined) client = await AcpClient.connectRemote(id, remote, handlers, signal)
      else if (this.config.mode === 'demo') client = await AcpClient.connectDemo(id, this.config.cwd, handlers)
      else client = await AcpClient.connect(id, this.config.dshExecutable ?? '', this.config.dshHome, this.config.cwd, handlers, signal, this.config.arcProfile)
      signal.throwIfAborted()
      ui = this.sessionFactory(client, store, {
        cwd: remote?.cwd ?? this.config.cwd,
        mode: this.config.mode,
        location: remote === undefined ? 'LOCAL' : `REMOTE ${remote.host}`,
        remote: remote !== undefined,
        onSwitch: () => { void this.switchRuntime() },
        onReconnect: () => { void this.switchRuntime(true) },
      })
      ui.setActive(false)
      ui.onChange(() => {
        if (!this.closing && this.endpoints.get(this.location)?.ui === ui) {
          this.changed()
          if (!this.transition && !this.headError) void this.persistHead({ client: client!, store, ui: ui! }, this.location).catch(error => {
            this.headError = true; ui?.showError(`ARC 索引保存失败：${String(error)}`)
          })
        }
      })
      if (location === 'local' && this.endpoints.size === 0) ui.setActive(true)
      return { client, store, ui }
    } catch (error) {
      const cleanup = await this.releaseResources(client, existingStore ? undefined : store)
      if (cleanup.length) throw new Error(`${String(error)}；资源清理失败：${cleanup.join('; ')}`)
      throw error
    }
  }

  close(): Promise<void> {
    return this.closePromise ??= this.doClose()
  }

  private async doClose(): Promise<void> {
    this.closing = true
    this.controller?.abort()
    await this.starting?.catch(() => undefined)
    const failures: unknown[] = []
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    await attempt(async () => this.transition)
    for (const endpoint of this.endpoints.values()) {
      await attempt(() => endpoint.ui.close())
      await attempt(() => endpoint.client.dispose())
      await attempt(() => endpoint.store.close())
    }
    this.endpoints.clear()
    for (const client of this.retiredClients) await attempt(() => client.dispose())
    for (const store of this.retiredStores) await attempt(() => store.close())
    this.retiredClients.clear(); this.retiredStores.clear()
    await this.headChain
    await attempt(async () => this.indexStore?.close())
    if (failures.length) throw new AggregateError(failures, 'ARC shutdown failed')
  }
}
