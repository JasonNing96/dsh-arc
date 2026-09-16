import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArcController } from '../dist/arc-controller.js'
import { ArcRuntimeSession } from '../dist/arc-runtime-session.js'
import type { StateStore } from '../dist/state-store.js'
import { AcpClient } from '../dist/acp-client.js'
import { resolveRuntimeConfig } from '../dist/runtime-config.js'

async function harness(onConnect?: (location: string, client: AcpClient) => void) {
  const root = await mkdtemp(join(tmpdir(), 'arc-headless-'))
  const paths = { local: join(root, 'local'), remote: join(root, 'remote') }
  await Promise.all(Object.values(paths).map(path => mkdir(path)))
  const config = resolveRuntimeConfig({ demo: true, cwd: paths.local, stateDir: join(root, 'state'), dshHome: undefined, dshExecutable: undefined })
  const remote = { host: 'fixture', cwd: paths.remote, dshHome: '/fixture', node: '/node', entry: '/dsh' }
  const clients = new Map<string, AcpClient>()
  const stores = new Map<string, StateStore>()
  let rejectRemote = false
  const make = () => new ArcController(config, remote, (client, store, options) => {
    stores.set(options.remote ? 'remote' : 'local', store)
    return new ArcRuntimeSession(client, store, options)
  }, async (location, id, handlers, signal) => {
    signal.throwIfAborted()
    if (rejectRemote && location === 'remote') throw new Error('fixture target refused')
    const previous = process.env.DSH_TUI_DEMO_STORE
    process.env.DSH_TUI_DEMO_STORE = join(root, location + '.json')
    try {
      const client = await AcpClient.connectDemo(id, paths[location], handlers)
      onConnect?.(location, client)
      clients.set(location, client)
      return client
    } finally {
      if (previous === undefined) delete process.env.DSH_TUI_DEMO_STORE
      else process.env.DSH_TUI_DEMO_STORE = previous
    }
  })
  let controller = make()
  await controller.start()
  return {
    root, clients, stores, get controller() { return controller }, rejectRemote() { rejectRemote = true },
    async restart() { await controller.close(); controller = make(); await controller.start() },
    async cleanup() { await controller.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('headless controller moves one conversation and draft between two independent ACP processes, then resumes', async () => {
  const h = await harness()
  try {
    const source = h.controller.activeSession!
    const conversation = source.conversation
    assert.equal(source.submit('headless local remembered'), true)
    assert.equal(source.submit('double delivery'), false)
    await source.waitForIdle()
    source.restoreInput({ buffer: '跨端草稿', cursor: 2 })
    const original = await source.exportConversationMirror()
    assert.equal(await h.controller.switchRuntime(), true)
    const target = h.controller.activeSession!
    assert.notEqual(target, source)
    assert.notEqual(target.sessionId, source.sessionId)
    assert.equal(target.conversation, conversation)
    assert.equal(h.controller.home, 'local')
    assert.deepEqual(target.uiState, { buffer: '跨端草稿', cursor: 2 })
    assert.deepEqual(target.transcript, original.entries)
    assert.equal(target.submit('headless remote followup'), true)
    await target.waitForIdle()
    target.restoreInput({ buffer: 'restart draft', cursor: 4 })
    const remoteId = target.sessionId
    await h.restart()
    assert.equal(h.controller.currentLocation, 'remote')
    assert.equal(h.controller.activeSession!.sessionId, remoteId)
    assert.equal(h.controller.activeSession!.conversation, conversation)
    assert.equal(h.controller.activeSession!.uiState.buffer, 'restart draft')
    assert.equal(h.controller.home, 'local')
    assert.equal(await h.controller.switchRuntime(), true)
    assert.equal(h.controller.activeSession!.conversation, conversation)
    assert.deepEqual(h.controller.activeSession!.transcript.filter(row => row.kind === 'user').map(row => row.text), ['headless local remembered', 'headless remote followup'])
  } finally { await h.cleanup() }
})

test('cleanup failure after commit preserves the target owner and exposes a warning', async () => {
  const h = await harness()
  try {
    const old = h.clients.get('local')!
    const dispose = old.dispose.bind(old)
    let calls = 0
    old.dispose = async () => { calls++; await dispose(); if (calls === 1) throw new Error('old transport cleanup failed') }
    const conversation = h.controller.activeSession!.conversation
    assert.equal(await h.controller.switchRuntime(), true)
    assert.equal(await h.controller.switchRuntime(), true)
    assert.equal(h.controller.currentLocation, 'local')
    assert.equal(h.controller.activeSession!.conversation, conversation)
    assert.equal(h.controller.connected, true)
    assert.match(h.controller.activeSession!.errorText, /old transport cleanup failed/)
    await h.controller.close()
    assert.equal(calls, 2, 'failed cleanup remains owned until shutdown retries it')
  } finally { await h.cleanup() }
})

test('failed import still releases target storage when transport cleanup reports an error', async () => {
  const h = await harness((location, client) => {
    if (location !== 'remote') return
    client.newSession = async () => { throw new Error('target import failed') }
    const dispose = client.dispose.bind(client)
    let first = true
    client.dispose = async () => { await dispose(); if (first) { first = false; throw new Error('target cleanup failed') } }
  })
  try {
    const source = h.controller.activeSession!
    source.restoreInput({ buffer: 'keep source', cursor: 11 })
    assert.equal(await h.controller.switchRuntime(), false)
    assert.equal(h.controller.activeSession, source)
    assert.equal(source.uiState.buffer, 'keep source')
    assert.match(source.errorText, /target import failed/)
    assert.match(source.errorText, /target cleanup failed/)
    const store = h.stores.get('remote')!
    assert.ok(!(await readdir(store.directory)).includes('lock.json'))
  } finally { await h.cleanup() }
})

test('headless target connection failure leaves source identity, history and unsent draft intact', async () => {
  const h = await harness()
  try {
    const source = h.controller.activeSession!
    source.restoreInput({ buffer: 'keep this draft', cursor: 3 })
    h.rejectRemote()
    assert.equal(await h.controller.switchRuntime(), false)
    assert.equal(h.controller.activeSession, source)
    assert.equal(source.uiState.buffer, 'keep this draft')
    assert.equal(source.transcript.length, 0)
    assert.equal(h.controller.connected, true)
    assert.match(source.errorText, /fixture target refused/)
  } finally { await h.cleanup() }
})

test('headless busy turn cannot switch; cancellation settles permission and resumes idle ownership', async () => {
  const h = await harness()
  try {
    const source = h.controller.activeSession!
    const seenPermission = new Promise<void>(resolve => source.onChange(() => { if (source.pendingPermission) resolve() }))
    assert.equal(source.submit('[permit] permission task'), true)
    await seenPermission
    assert.equal(await h.controller.switchRuntime(), false)
    const requestId = source.pendingPermission!.id
    await source.cancel()
    source.replyPermission(requestId, 'allow')
    assert.equal(source.pendingPermission, undefined)
    assert.equal(source.running, 'idle')
    assert.equal(await h.controller.switchRuntime(), true)
  } finally { await h.cleanup() }
})

test('headless late events for the old endpoint cannot alter the active conversation', async () => {
  const h = await harness()
  try {
    const source = h.controller.activeSession!
    assert.equal(await h.controller.switchRuntime(), true)
    const target = h.controller.activeSession!
    const before = target.transcript.slice()
    source.clientHandlers.onUpdate(source.sessionId!, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_SOURCE' } })
    const replies: unknown[] = []
    source.clientHandlers.onRequestPermission(source.sessionId!, { sessionId: source.sessionId!, toolCall: { toolCallId: 'stale', title: 'STALE_REQUEST' }, options: [] }, value => replies.push(value))
    assert.deepEqual(target.transcript, before)
    assert.deepEqual(replies, [{ outcome: { outcome: 'cancelled' } }])
  } finally { await h.cleanup() }
})

test('headless unsaved state prevents handoff and shutdown still releases every lock', async () => {
  const h = await harness()
  const store = h.stores.get('local')!
  const save = store.saveDraft.bind(store)
  try {
    store.saveDraft = async () => { throw new Error('fixture disk failure') }
    assert.equal(await h.controller.switchRuntime(), false)
    assert.match(h.controller.activeSession!.unsavedWarning, /fixture disk failure/)
    store.saveDraft = save
    await assert.rejects(h.controller.close(), /ARC shutdown failed/)
    for (const directory of await readdir(join(h.root, 'state/runtimes'))) {
      assert.ok(!(await readdir(join(h.root, 'state/runtimes', directory))).includes('lock.json'))
    }
  } finally { await rm(h.root, { recursive: true, force: true }) }
})
