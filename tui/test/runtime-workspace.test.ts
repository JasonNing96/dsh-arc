import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient } from '../dist/acp-client.js'
import { RuntimeWorkspace, type Location } from '../dist/runtime-workspace.js'
import { resolveRuntimeConfig } from '../dist/runtime-config.js'
import { until } from './harness.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-switch-'))
  const paths = { local: join(root, 'local'), remote: join(root, 'remote') }
  await Promise.all(Object.values(paths).map(path => mkdir(path)))
  const config = resolveRuntimeConfig({ demo: true, cwd: paths.local, stateDir: join(root, 'state'),
    dshHome: undefined, dshExecutable: undefined })
  const remote = { host: 'test-remote', cwd: paths.remote, dshHome: '/isolated', node: '/node', entry: '/dsh' }
  const clients = new Map<Location, AcpClient>()
  let fail = false
  let hold = false
  let rejectImport = false
  let waiting = false
  const screen: string[] = []
  const workspace = new RuntimeWorkspace(config, remote, text => screen.push(text), async (location, id, handlers, signal) => {
    if (location === 'remote' && fail) throw new Error('SSH authentication failed')
    if (location === 'remote' && hold) waiting = true
    if (location === 'remote' && hold) await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
    process.env.DSH_TUI_DEMO_STORE = join(root, location + '.json')
    const client = await AcpClient.connectDemo(id, paths[location], handlers)
    if (location === 'remote' && rejectImport) client.newSession = async () => { throw new Error('target import rejected') }
    clients.set(location, client)
    return client
  })
  await workspace.start()
  return { root, workspace, clients, screen, get waiting() { return waiting }, setFail: (value: boolean) => { fail = value }, setImportFail: (value: boolean) => { rejectImport = value },
    setHold: (value: boolean) => { hold = value },
    cleanup: async () => { await workspace.close(); await rm(root, { recursive: true, force: true }) } }
}

test('switch retains the same conversation and draft in both directions without Ctrl+N', async () => {
  const h = await fixture()
  try {
    const local = h.workspace.activeUi!
    const conversation = local.conversation
    await local.feed(Buffer.from('本机未发送草稿'))
    assert.equal(await h.workspace.switchRuntime(), true)
    const remote = h.workspace.activeUi!
    assert.ok(remote.sessionId)
    assert.equal(remote.conversation, conversation)
    assert.equal(remote.uiState.buffer, '本机未发送草稿')
    assert.ok(!h.screen.at(-1)?.includes('会话列表'))
    remote.restoreInput({ buffer: 'remote task', cursor: 11 })
    await remote.submit()
    assert.equal(h.clients.get('remote')?.workspaceCwd, join(h.root, 'remote'))
    await remote.feed(Buffer.from('随对话返回'))
    assert.equal(await h.workspace.switchRuntime(), true)
    assert.equal(h.workspace.activeUi?.conversation, conversation)
    assert.equal(h.workspace.activeUi?.uiState.buffer, '随对话返回')
    assert.ok(h.workspace.activeUi?.displayLines.some(line => line.text.includes('remote task')))
    assert.notEqual(h.workspace.activeUi?.sessionId, local.sessionId)
  } finally { await h.cleanup() }
})

test('authentication failure retains source endpoint and draft; no hidden prompt is sent', async () => {
  const h = await fixture()
  try {
    const source = h.workspace.activeUi!
    await source.feed(Buffer.from('do not send this'))
    h.setFail(true)
    assert.equal(await h.workspace.switchRuntime(), false)
    assert.equal(h.workspace.currentLocation, 'local')
    assert.equal(source.uiState.buffer, 'do not send this')
    assert.match(source.errorText, /SSH authentication failed/)
    assert.ok(!source.displayLines.some(line => line.kind === 'user'))
  } finally { await h.cleanup() }
})

test('during connection, typing stays in source; Enter is blocked and Ctrl+C cancels the switch', async () => {
  const h = await fixture()
  try {
    h.setHold(true)
    const source = h.workspace.activeUi!
    const switching = h.workspace.switchRuntime()
    await until(() => h.waiting)
    await source.feed(Buffer.from('保留输入\r'))
    await source.feed(Buffer.from('\x03'))
    assert.equal(await switching, false)
    assert.equal(source.uiState.buffer, '保留输入')
    assert.ok(!source.displayLines.some(line => line.kind === 'user'))
    assert.equal(h.workspace.currentLocation, 'local')
  } finally { await h.cleanup() }
})

test('busy turn refuses switching, and disconnected submission preserves its draft', async () => {
  const h = await fixture()
  try {
    const source = h.workspace.activeUi!
    await source.feed(Buffer.from('[cancel] one two three four\r'))
    assert.equal(await h.workspace.switchRuntime(), false)
    await source.feed(Buffer.from('\x03'))
    await until(() => source.running === 'idle')
    await h.clients.get('local')?.dispose()
    await source.feed(Buffer.from('retry manually\r'))
    assert.equal(source.uiState.buffer, 'retry manually')
    assert.match(source.errorText, /重连/)
  } finally { await h.cleanup() }
})

test('reconnect uses the same runtime namespace and resumes context/draft without re-sending input', async () => {
  const h = await fixture()
  try {
    assert.equal(await h.workspace.switchRuntime(), true)
    await h.workspace.activeUi?.feed(Buffer.from('\x0e'))
    const old = h.workspace.activeUi!
    const sessionId = old.sessionId
    await old.feed(Buffer.from('remote pending draft'))
    await h.clients.get('remote')?.dispose()
    assert.equal(await h.workspace.switchRuntime(true), true)
    assert.equal(h.workspace.currentLocation, 'remote')
    assert.equal(h.workspace.activeUi?.sessionId, sessionId)
    assert.equal(h.workspace.activeUi?.uiState.buffer, 'remote pending draft')
    assert.ok(!h.workspace.activeUi?.displayLines.some(line => line.kind === 'user'))
  } finally { await h.cleanup() }
})

test('a paste split across connection completion stays wholly in the source draft', async () => {
  const h = await fixture()
  try {
    const source = h.workspace.activeUi!
    const switching = h.workspace.switchRuntime()
    await source.feed(Buffer.from('\x1b[200~第一段'))
    await until(() => h.clients.has('remote'))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(h.workspace.currentLocation, 'local')
    await source.feed(Buffer.from('\n第二段\x1b[201~'))
    assert.equal(await switching, true)
    assert.equal(source.uiState.buffer, '第一段\n第二段')
    assert.equal(h.workspace.activeUi?.uiState.buffer, '第一段\n第二段')
  } finally { await h.cleanup() }
})

test('Ctrl+N after handoff explicitly creates a new, empty conversation', async () => {
  const h = await fixture()
  try {
    await h.workspace.switchRuntime()
    const ui = h.workspace.activeUi!
    const old = ui.conversation
    await ui.feed(Buffer.from('old draft'))
    await ui.feed(Buffer.from('\x0e'))
    assert.notEqual(ui.conversation, old)
    assert.equal(ui.uiState.buffer, '')
    assert.equal(ui.displayLines.length, 0)
  } finally { await h.cleanup() }
})

test('failed checkpoint export leaves the source session, conversation and draft usable', async () => {
  const h = await fixture()
  try {
    const source = h.workspace.activeUi!
    const id = source.sessionId
    await source.feed(Buffer.from('keep me'))
    h.clients.get('local')!.exportCheckpoint = async () => { throw new Error('incomplete tool result') }
    assert.equal(await h.workspace.switchRuntime(), false)
    assert.equal(h.workspace.activeUi, source)
    assert.equal(source.sessionId, id)
    assert.equal(source.uiState.buffer, 'keep me')
    assert.ok(h.clients.get('local')?.connected)
    assert.equal(source.displayLines.filter(line => line.kind === 'user').length, 0)
  } finally { await h.cleanup() }
})


test('target import rejection keeps the original conversation and draft without a hidden submit', async () => {
  const h = await fixture()
  try {
    const source = h.workspace.activeUi!
    await source.feed(Buffer.from('保留草稿'))
    h.setImportFail(true)
    assert.equal(await h.workspace.switchRuntime(), false)
    assert.equal(h.workspace.activeUi, source)
    assert.equal(source.uiState.buffer, '保留草稿')
    assert.match(source.errorText, /target import rejected/)
    assert.ok(h.clients.get('local')?.connected)
    assert.equal(h.clients.get('remote')?.connected, false)
    assert.equal(source.displayLines.filter(line => line.kind === 'user').length, 0)
  } finally { await h.cleanup() }
})

test('late cancellation during durable commit cannot dispose the newly committed target', async () => {
  const h=await fixture()
  const persist=h.workspace['persistHead'].bind(h.workspace)
  let entered!:()=>void, release!:()=>void
  const committing=new Promise<void>(resolve=>{entered=resolve})
  const gate=new Promise<void>(resolve=>{release=resolve})
  h.workspace['persistHead']=async (endpoint,location)=>{if(location==='remote'){entered();await gate}await persist(endpoint,location)}
  try {
    const switching=h.workspace.switchRuntime()
    await committing
    await h.workspace.activeUi!.feed(Buffer.from('\x03'))
    release()
    assert.equal(await switching,true)
    assert.equal(h.workspace.currentLocation,'remote')
    assert.equal(h.workspace.connected,true)
    assert.equal(h.clients.get('remote')?.connected,true)
    assert.equal(h.workspace.home,'local')
  }finally{release();await h.cleanup()}
})
