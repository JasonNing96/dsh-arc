/**
 * KeyDecoder and buffer-editing behavior: fragmented multibyte input,
 * fragmented bracketed paste, grapheme editing, submit rules.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { KeyDecoder, decodeKeys, deleteOne, insertAt, shouldSubmit, stripControl } from './line-editor-shim.ts'

test('plain ASCII chars decode individually', () => {
  const events = decodeKeys(Buffer.from('ab', 'utf8'))
  assert.deepEqual(events.map(event => event.name), ['char', 'char'])
  assert.equal(events.map(event => event.text).join(''), 'ab')
})

test('Chinese input decodes as whole characters', () => {
  const events = decodeKeys(Buffer.from('你好', 'utf8'))
  assert.equal(events.length, 2)
  assert.equal(events.map(event => event.text).join(''), '你好')
})

test('astral emoji decodes as one event', () => {
  const events = decodeKeys(Buffer.from('👍', 'utf8'))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.text, '👍')
})

test('fragmented Chinese across chunks reassembles (stateful decoder)', () => {
  const decoder = new KeyDecoder()
  const bytes = Buffer.from('你好', 'utf8')
  assert.deepEqual(decoder.push(bytes.subarray(0, 2)), []) // partial 你
  const events = decoder.push(bytes.subarray(2))
  assert.equal(events.length, 2)
  assert.equal(events.map(event => event.text).join(''), '你好')
})

test('fragmented 4-byte emoji across chunks reassembles', () => {
  const decoder = new KeyDecoder()
  const bytes = Buffer.from('😀', 'utf8')
  assert.deepEqual(decoder.push(bytes.subarray(0, 2)), [])
  const events = decoder.push(bytes.subarray(2))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.text, '😀')
})

test('arrow, delete, page keys decode', () => {
  assert.equal(decodeKeys(Buffer.from('\x1b[D', 'utf8'))[0]?.name, 'left')
  assert.equal(decodeKeys(Buffer.from('\x1b[A', 'utf8'))[0]?.name, 'up')
  assert.equal(decodeKeys(Buffer.from('\x1b[3~', 'utf8'))[0]?.name, 'delete')
  assert.equal(decodeKeys(Buffer.from('\x1b[5~', 'utf8'))[0]?.name, 'pageup')
  assert.equal(decodeKeys(Buffer.from('\x1b[6~', 'utf8'))[0]?.name, 'pagedown')
})

test('Enter, LF, Backspace, Ctrl+C decode distinctly', () => {
  assert.equal(decodeKeys(Buffer.from('\r', 'utf8'))[0]?.name, 'enter')
  assert.equal(decodeKeys(Buffer.from('\n', 'utf8'))[0]?.name, 'newline')
  assert.equal(decodeKeys(Buffer.from('\x7f', 'utf8'))[0]?.name, 'backspace')
  assert.equal(decodeKeys(Buffer.from('\x03', 'utf8'))[0]?.name, 'ctrl-c')
})

test('Alt+Enter decodes as alt-enter', () => {
  const events = decodeKeys(Buffer.from('\x1b\r', 'utf8'))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.name, 'alt-enter')
})

test('bracketed paste decodes as one paste event', () => {
  const payload = 'line1\nline2 中文\nline3\n'
  const events = decodeKeys(Buffer.from(`\x1b[200~${payload}\x1b[201~`, 'utf8'))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.name, 'paste')
  assert.equal(events[0]?.text, payload)
})

test('fragmented bracketed paste (marker and payload split) never submits', () => {
  const decoder = new KeyDecoder()
  const payload = '第一行\n第二行\x03结尾'
  const whole = Buffer.from(`\x1b[200~${payload}\x1b[201~`, 'utf8')
  // Feed byte-by-byte: worst-case fragmentation.
  for (let i = 0; i < whole.length; i += 1) {
    const events = decoder.push(whole.subarray(i, i + 1))
    for (const event of events) {
      assert.notEqual(event.name, 'enter', 'fragmented paste must never decode as Enter')
    }
    if (events.length > 0) {
      assert.equal(events.length, 1)
      assert.equal(events[0]?.name, 'paste')
      assert.equal(events[0]?.text, payload)
    }
  }
})

test('paste and typed keys in one chunk', () => {
  const events = decodeKeys(Buffer.from(`a\x1b[200~p1\np2\x1b[201~b`, 'utf8'))
  assert.deepEqual(events.map(event => event.name), ['char', 'paste', 'char'])
})

test('backspace deletes one CJK character (grapheme) at a time', () => {
  let state = { buffer: '你好世界', cursor: 4 }
  state = deleteOne(state.buffer, state.cursor, 'back')
  assert.equal(state.buffer, '你好世')
  assert.equal(state.cursor, 3)
})

test('backspace deletes an emoji with skin tone as one cluster', () => {
  const state = deleteOne('a👍🏽b', 2, 'back')
  assert.equal(state.buffer, 'ab')
  assert.equal(state.cursor, 1)
})

test('combining marks backspace with their base', () => {
  const state = deleteOne('aéb', 2, 'back')
  assert.equal(state.buffer, 'ab')
})

test('insert at cursor keeps grapheme alignment', () => {
  const moved = insertAt('你好', 1, 'X')
  assert.equal(moved.buffer, '你X好')
  assert.equal(moved.cursor, 2)
})

test('submit rules: Enter/alt-enter submit; newline and paste never', () => {
  const enter = decodeKeys(Buffer.from('\r', 'utf8'))[0]
  const lf = decodeKeys(Buffer.from('\n', 'utf8'))[0]
  const altEnter = decodeKeys(Buffer.from('\x1b\r', 'utf8'))[0]
  const paste = decodeKeys(Buffer.from('\x1b[200~x\ny\x1b[201~', 'utf8'))[0]
  assert.ok(enter !== undefined && lf !== undefined && altEnter !== undefined && paste !== undefined)
  assert.equal(shouldSubmit(enter), true)
  assert.equal(shouldSubmit(altEnter), true)
  assert.equal(shouldSubmit(lf), false)
  assert.equal(shouldSubmit(paste), false)
})

test('a lone Escape waits for the idle flush; a split CSI remains one key', () => {
  const decoder = new KeyDecoder()
  assert.deepEqual(decoder.push(Buffer.from('\x1b')), [])
  assert.equal(decoder.flushEscape()[0]?.name, 'escape')
  assert.deepEqual(decoder.push(Buffer.from('\x1b')), [])
  assert.equal(decoder.push(Buffer.from('[D'))[0]?.name, 'left')
})

test('typing a combining mark keeps the cursor within the composed grapheme', () => {
  assert.deepEqual(insertAt('e', 1, '\u0301'), { buffer: 'é', cursor: 1 })
})
