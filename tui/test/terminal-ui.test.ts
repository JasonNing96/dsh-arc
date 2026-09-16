/**
 * TerminalUi behavior tests over the demo subprocess: submission flow,
 * interrupt, permission overlay, transcript mirroring, drafts, and session
 * resume display.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AcpClient } from '../dist/acp-client.js'
import { StateStore } from '../dist/state-store.js'
import { TerminalUi } from '../dist/terminal-ui.js'
import { DEMO_MARKERS } from '../dist/demo-runtime.js'
import { displayWidth } from '../dist/line-editor.js'
import { stripControlSequences } from '../dist/terminal-ui.js'
import { until } from './harness.ts'

async function uiHarness(decision: 'allow' | 'reject' | 'cancel' = 'cancel'): Promise<{
  ui: TerminalUi
  client: AcpClient
  store: StateStore
  screen: string[]
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-ui-'))
  const workspace = join(root, 'ws')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  process.env.DSH_TUI_DEMO_STORE = join(root, 'demo-sessions.json')
  const store = await StateStore.open(join(root, 'state'), 'demo-ui')

  // Connect with bridged handlers (like cli.ts): events flow into a late-
  // bound UI reference, so nothing is dropped while wiring runs.
  let ui: TerminalUi | undefined
  const client = await AcpClient.connectDemo('demo-ui', workspace, {
    onUpdate: (sessionId, update) => { ui?.clientHandlers.onUpdate(sessionId, update) },
    onRequestPermission: (sessionId, request, settle) => {
      ui?.clientHandlers.onRequestPermission(sessionId, request, settle)
    },
    onDisconnect: (reason) => { ui?.clientHandlers.onDisconnect(reason) },
  })
  const screen: string[] = []
  ui = new TerminalUi(client, store, { cwd: workspace, mode: 'demo' }, (text) => { screen.push(text) })
  await ui.createSession()
  return {
    ui,
    client,
    store,
    screen,
    cleanup: async () => {
      await ui?.quit()
      await client.dispose()
      await store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('ui: typed Chinese input accumulates; Enter submits; transcript mirrors to disk', async () => {
  const h = await uiHarness()
  try {
    for (const char of '你好') {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    assert.equal(h.ui.uiState.buffer, '你好')
    await h.ui.feed(Buffer.from('\r', 'utf8'))
    await until(() => h.ui.running === 'idle' && h.ui.displayLines.some(line => line.kind === 'status'), 5000, 'turn end')
    const mirror = await h.store.loadMirror(h.ui.sessionId ?? '')
    assert.ok(mirror !== null)
    assert.ok(mirror.entries.some(entry => entry.kind === 'user' && entry.text === '你好'))
    assert.ok(mirror.entries.some(entry => entry.kind === 'assistant'))
    assert.ok(mirror.entries.some(entry => entry.kind === 'tool'))
  } finally {
    await h.cleanup()
  }
})

test('ui: busy state during a turn; Ctrl+C cancels', async () => {
  const h = await uiHarness()
  try {
    const slowPrompt = `${DEMO_MARKERS.cancel} a b c d e f g h`
    for (const char of slowPrompt) {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    await h.ui.feed(Buffer.from('\r', 'utf8'))
    await until(() => h.ui.running === 'busy', 3000, 'busy')
    await h.ui.feed(Buffer.from('\x03', 'utf8'))
    await until(() => h.ui.running === 'cancelling', 3000, 'cancelling')
    await until(() => h.ui.running === 'idle', 5000, 'idle after cancel')
    const mirror = await h.store.loadMirror(h.ui.sessionId ?? '')
    assert.ok(mirror !== null)
    // Cancellation result recorded.
    assert.ok(mirror.entries.some(entry => entry.kind === 'status' && entry.text.includes('cancelled')))
  } finally {
    await h.cleanup()
  }
})

test('ui: multiline paste does not submit; Alt+Enter submits', async () => {
  const h = await uiHarness()
  try {
    await h.ui.feed(Buffer.concat([
      Buffer.from('\x1b[200~', 'utf8'),
      Buffer.from('第一行\n第二行', 'utf8'),
      Buffer.from('\x1b[201~', 'utf8'),
    ]))
    assert.equal(h.ui.uiState.buffer, '第一行\n第二行')
    assert.equal(h.ui.running, 'idle', 'paste alone never submits')
    // Ctrl+J inserts a newline; Enter/Alt+Enter explicitly submit.
    await h.ui.feed(Buffer.from('\n', 'utf8'))
    assert.equal(h.ui.uiState.buffer, '第一行\n第二行\n')
    // Alt+Enter (ESC + CR) submits explicitly.
    await h.ui.feed(Buffer.from('\x1b\r', 'utf8'))
    await until(() => h.ui.running === 'idle' && h.ui.uiState.buffer === '', 5000, 'submitted')
    const mirror = await h.store.loadMirror(h.ui.sessionId ?? '')
    assert.ok(mirror?.entries.some(entry => entry.kind === 'user' && entry.text === '第一行\n第二行\n'))
  } finally {
    await h.cleanup()
  }
})

test('ui: permission overlay captures keys; y approves exactly the pending request', async () => {
  const h = await uiHarness()
  try {
    const ask = `${DEMO_MARKERS.permit} 需要权限`
    for (const char of ask) {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    await h.ui.feed(Buffer.from('\r', 'utf8'))
    await until(() => h.ui.pendingPermission !== undefined, 5000, 'permission overlay')
    const request = h.ui.pendingPermission
    assert.ok(request !== undefined)
    assert.deepEqual(
      request.options.map(option => option.kind).sort(),
      ['allow_once', 'reject_once'],
    )
    await h.ui.feed(Buffer.from('y', 'utf8'))
    await until(() => h.ui.pendingPermission === undefined, 3000, 'overlay cleared')
    await until(() => h.ui.running === 'idle', 5000, 'turn ends after approval')
  } finally {
    await h.cleanup()
  }
})

test('ui: Ctrl+S opens the session list; Esc closes it', async () => {
  const h = await uiHarness()
  try {
    await h.ui.feed(Buffer.from('\x13', 'utf8'))
    // The list shows at least the current session (active ones are excluded
    // from session/list but merged back).
    await until(() => h.screen.some(text => text.includes('会话列表')), 3000, 'overlay rendered')
    await h.ui.feed(Buffer.from('\x1b', 'utf8'))
    await until(() => !h.screen.at(-1)?.includes('回车切换选中会话'), 1000, 'Escape closes picker')
  } finally {
    await h.cleanup()
  }
})

test('ui: quit saves the draft for the next start', async () => {
  const h = await uiHarness()
  const sessionId = h.ui.sessionId ?? ''
  try {
    for (const char of '未发送的草稿') {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    await h.ui.quit()
    assert.equal(await h.store.loadDraft(sessionId), '未发送的草稿')
  } finally {
    await h.cleanup()
  }
})

test('ui: resume shows mirror history; unknown sessions state unavailable', async () => {
  const h = await uiHarness()
  const sessionId = h.ui.sessionId ?? ''
  try {
    for (const char of '第一句') {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    await h.ui.feed(Buffer.from('\r', 'utf8'))
    await until(() => h.ui.running === 'idle' && h.ui.displayLines.some(line => line.kind === 'status'), 5000, 'turn done')
    // Close so the demo runtime lets us resume it.
    await h.client.closeSession(sessionId)
    await h.ui.resumeSession(sessionId)
    assert.ok(h.ui.displayLines.some(line => line.kind === 'status' && line.text.includes('镜像')))
    assert.ok(h.ui.displayLines.some(line => line.kind === 'user' && line.text === '第一句'))
  } finally {
    await h.cleanup()
  }
})

test('ui: async output during typing never eats input', async () => {
  const h = await uiHarness()
  try {
    // Start a slow turn, then keep typing while it emits.
    for (const char of `${DEMO_MARKERS.cancel} 输出中打字`) {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    await h.ui.feed(Buffer.from('\r', 'utf8'))
    await until(() => h.ui.running === 'busy', 3000, 'busy')
    for (const char of '正在输入') {
      await h.ui.feed(Buffer.from(char, 'utf8'))
    }
    assert.equal(h.ui.uiState.buffer, '正在输入')
    await h.ui.feed(Buffer.from('\x03', 'utf8'))
    await until(() => h.ui.running === 'idle', 5000, 'idle')
    assert.equal(h.ui.uiState.buffer, '正在输入', 'input intact after async output')
  } finally {
    await h.cleanup()
  }
})

test('ui: narrow screen keeps every row bounded and the multiline cursor on its actual line', async () => {
  const h = await uiHarness()
  try {
    h.ui.setSize(12, 40)
    await h.ui.feed(Buffer.from('\x1b[200~第一行🚀\n第二行\n第三行\x1b[201~'))
    await h.ui.feed(Buffer.from('\x1b[A'))
    assert.equal(h.ui.uiState.cursor, 8) // 第二行末尾, grapheme indexes
    h.ui.clientHandlers.onUpdate(h.ui.sessionId ?? '', { sessionUpdate: 'agent_message_chunk', content: {
      type: 'text', text: '很长的输出🚀'.repeat(80),
    } })
    const lines = stripControlSequences(h.screen.at(-1) ?? '').split('\n')
    assert.equal(lines.length, 12)
    assert.ok(lines.every(line => displayWidth(line) <= 39))
    assert.ok(lines.some(line => line.includes('> 第二行▏')))
    assert.ok(lines[0]?.includes('DEMO'))
  } finally { await h.cleanup() }
})

test('ui: switching back records resume status only in the destination mirror', async () => {
  const h = await uiHarness()
  try {
    const first = h.ui.sessionId ?? ''
    await h.ui.createSession()
    const second = h.ui.sessionId ?? ''
    await h.ui.resumeSession(first)
    assert.ok((await h.store.loadMirror(first))?.entries.some(e => e.text.includes('已恢复')))
    assert.ok(!(await h.store.loadMirror(second))?.entries.some(e => e.text.includes('已恢复')))
  } finally { await h.cleanup() }
})

test('a long input chunk redraws once instead of blocking the PTY with a frame per character', async () => {
  const h = await uiHarness()
  try {
    const before = h.screen.length
    const text = '中文 long input '.repeat(40)
    await h.ui.feed(Buffer.from(text))
    assert.equal(h.ui.uiState.buffer, text)
    assert.equal(h.screen.length - before, 1)
  } finally { await h.cleanup() }
})

test('live chunks grow one visible reply, then committed content is persisted exactly once', async () => {
  const h = await uiHarness()
  try {
    const sid = h.ui.sessionId!
    const stream = (frame: unknown) => h.ui.clientHandlers.onStream(sid, frame as never)
    stream({ type: 'start', attemptId: 'live:1', revision: 1, turn: 1, step: 1 })
    stream({ type: 'chunk', attemptId: 'live:1', revision: 2, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '第一段' } })
    await until(() => h.screen.at(-1)?.includes('第一段') === true)
    assert.equal((await h.store.loadMirror(sid))?.entries.filter(e => e.kind === 'assistant').length, 0)
    stream({ type: 'chunk', attemptId: 'live:1', revision: 3, index: 1, time: 2,
      chunk: { type: 'text-delta', index: 0, text: '第二段' } })
    await until(() => h.screen.at(-1)?.includes('第一段第二段') === true)
    h.ui.clientHandlers.onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一段第二段' } })
    stream({ type: 'end', attemptId: 'live:1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } })
    await h.ui.saveDraftNow()
    assert.deepEqual((await h.store.loadMirror(sid))?.entries.filter(e => e.kind === 'assistant').map(e => e.text), ['第一段第二段'])
  } finally { await h.cleanup() }
})

test('disconnect preserves a marked partial response; late stream events cannot duplicate it', async () => {
  const h = await uiHarness()
  try {
    const sid = h.ui.sessionId!
    h.ui.clientHandlers.onStream(sid, { type: 'start', attemptId: 'partial:1', revision: 1, turn: 1, step: 1 } as never)
    h.ui.clientHandlers.onStream(sid, { type: 'chunk', attemptId: 'partial:1', revision: 2, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: '部分内容' } } as never)
    h.ui.clientHandlers.onDisconnect('test transport loss')
    await h.ui.saveDraftNow()
    assert.deepEqual((await h.store.loadMirror(sid))?.entries.filter(e => e.kind === 'assistant').map(e => e.text), ['[未完成输出] 部分内容'])
  } finally { await h.cleanup() }
})

test('ui: stale/inactive/overlapping permission requests cannot replace the active one-shot decision', async () => {
  const h=await uiHarness()
  try {
    const sid=h.ui.sessionId!
    const request={sessionId:sid,toolCall:{toolCallId:'guard-test',title:'guard test'},options:[
      {optionId:'once',kind:'allow_once' as const,name:'Allow once'},
      {optionId:'deny',kind:'reject_once' as const,name:'Deny once'}]}
    const rejected:unknown[]=[]
    h.ui.setActive(false)
    h.ui.clientHandlers.onRequestPermission(sid,request,value=>rejected.push(value))
    h.ui.setActive(true)
    h.ui.clientHandlers.onRequestPermission('other-session',request,value=>rejected.push(value))
    const allowed:unknown[]=[]
    h.ui.clientHandlers.onRequestPermission(sid,request,value=>allowed.push(value))
    h.ui.clientHandlers.onRequestPermission(sid,request,value=>rejected.push(value))
    assert.equal(rejected.length,3)
    assert.ok(rejected.every(value=>JSON.stringify(value)===JSON.stringify({outcome:{outcome:'cancelled'}})))
    h.ui.decidePermission('allow'); h.ui.decidePermission('allow')
    assert.deepEqual(allowed,[{outcome:{outcome:'selected',optionId:'once'}}])
    assert.equal(h.ui.pendingPermission,undefined)
  } finally {await h.cleanup()}
})
