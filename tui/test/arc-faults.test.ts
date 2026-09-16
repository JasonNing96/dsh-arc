import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ArcRuntimeSession } from '../dist/arc-runtime-session.js'
import { ArcController } from '../dist/arc-controller.js'
import { resolveRuntimeConfig } from '../dist/runtime-config.js'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectFake, openTestStore, until, type FakeRuntime } from './harness.ts'

/** A real ACP wire peer that deliberately never answers prompt/cancel. */
async function unresponsiveSession() {
  let session: ArcRuntimeSession | undefined
  const { client, fake } = await connectFake({
    onUpdate: (...args) => session?.clientHandlers.onUpdate(...args),
    onStream: (...args) => session?.clientHandlers.onStream(...args),
    onDisconnect: (...args) => session?.clientHandlers.onDisconnect(...args),
    onRequestPermission: (...args) => session?.clientHandlers.onRequestPermission(...args),
  })
  const { store, cleanup } = await openTestStore('unresponsive')
  session = new ArcRuntimeSession(client, store, { cwd: '/tmp', location: 'LOCAL' })
  const creating = session.createSession()
  await until(() => fake.sent.some(line => line.method === 'session/new'))
  fake.send({ jsonrpc: '2.0', id: fake.sent.find(line => line.method === 'session/new')!.id,
    result: { sessionId: 'unresponsive', configOptions: [] } })
  assert.equal(await creating, true)
  session.setActive(true)
  assert.equal(session.submit('Run once'), true)
  await until(() => fake.sent.some(line => line.method === 'session/prompt'))
  return { session, client, fake, store, async cleanup() { fake.kill(); await client.dispose(); await session!.close(); await cleanup() } }
}

test('unresponsive cancel disconnects within a bounded grace period and does not accept another turn', async () => {
  const h = await unresponsiveSession()
  try {
    let settled = false
    const cancelling = h.session.cancel().then(() => { settled = true })
    await until(() => settled, 6000, 'bounded cancel')
    await cancelling
    assert.equal(h.client.connected, false)
    assert.equal(h.session.running, 'idle')
    assert.match(h.session.errorText, /unknown|未知/)
    h.session.restoreInput({ buffer: 'retry deliberately', cursor: 18 })
    assert.equal(h.session.submit('retry deliberately'), false)
    assert.equal(h.session.uiState.buffer, 'retry deliberately')
    assert.equal(h.fake.sent.filter(line => line.method === 'session/prompt').length, 1)
  } finally { await h.cleanup() }
})

test('unload during an unresponsive turn settles transport and retains the unsent draft', async () => {
  const h = await unresponsiveSession()
  try {
    h.session.restoreInput({ buffer: 'keep on unload', cursor: 14 })
    let settled = false
    const closing = h.session.close()
    assert.equal(h.session.close(), closing)
    void closing.then(() => { settled = true })
    await until(() => settled, 6000, 'bounded unload')
    await closing
    assert.equal(h.client.connected, false)
    assert.equal(h.fake.sent.filter(line => line.method === 'session/prompt').length, 1)
    assert.equal(h.session.uiState.buffer, 'keep on unload')
    assert.equal(await h.store.loadDraft(h.session.sessionId!), 'keep on unload')
    assert.ok((await h.store.loadMirror(h.session.sessionId!))!.entries.some(entry => entry.text.includes('outcome is unknown')))
  } finally { await h.cleanup() }
})

test('unload denies an outstanding permission exactly once and rejects its late approval', async () => {
  const h = await unresponsiveSession()
  try {
    h.fake.send({ jsonrpc: '2.0', id: 700, method: 'session/request_permission', params: {
      sessionId: h.session.sessionId, toolCall: { toolCallId: 'write', title: 'Write confidential file' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
    } })
    await until(() => !!h.session.pendingPermission)
    const permission = h.session.pendingPermission!.id
    const closing = h.session.close()
    await until(() => h.fake.sent.some(line => line.id === 700))
    h.session.replyPermission(permission, 'allow')
    await closing
    const replies = h.fake.sent.filter(line => line.id === 700)
    assert.deepEqual(replies.map(line => line.result), [{ outcome: { outcome: 'cancelled' } }])
    assert.equal(h.session.pendingPermission, undefined)
  } finally { await h.cleanup() }
})

test('closing after ACP initialization aborts a stalled initial session request and releases locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-start-request-'))
  const config = resolveRuntimeConfig({ demo: true, cwd: root, stateDir: join(root, 'state'), dshHome: undefined, dshExecutable: undefined })
  let fake: FakeRuntime | undefined
  const controller = new ArcController(config, undefined, (client, store, options) => new ArcRuntimeSession(client, store, options),
    async (_location, _id, handlers) => {
      const peer = await connectFake(handlers)
      fake = peer.fake
      return peer.client
    })
  const starting = assert.rejects(controller.start())
  try {
    await until(() => !!fake?.sent.some(line => line.method === 'session/new'))
    let closed = false
    const closing = controller.close().then(() => { closed = true })
    await until(() => closed, 2000, 'abort initial session request')
    await closing; await starting
    for (const directory of await readdir(join(root, 'state/runtimes'))) {
      const names = await readdir(join(root, 'state/runtimes', directory))
      assert.ok(!names.includes('lock.json'))
      assert.ok(!names.includes('active.json'))
    }
  } finally { fake?.kill(); await controller.close(); await starting; await rm(root, { recursive: true, force: true }) }
})
