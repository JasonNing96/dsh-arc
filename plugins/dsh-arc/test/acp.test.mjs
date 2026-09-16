import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { harness, fixture } from './harness.mjs'
import * as acp from '../lib/acp.js'

async function connect(h, events, permission = () => ({ outcome: { outcome: 'cancelled' } })) {
  const toHost = new TransformStream()
  const toClient = new TransformStream()
  await h.ctx.plugin(acp, { provider: 'fixture', model: 'fixture',
    stream: { readable: toHost.readable, writable: toClient.writable } })
  const connection = client({ name: 'arc-test' })
    .onNotification('_dsh/stream', value => value, ({ params }) => events.push(params.frame))
    .onNotification('session/update', value => value, () => {})
    .onRequest('session/request_permission', value => value, ({ params }) => permission(params))
    .connect({ readable: toClient.readable, writable: toHost.writable })
  const info = await connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  assert.equal(info._meta.dshArcPlugin, 1)
  return connection
}

class FixtureAdapter extends LlmAdapter {
  calls = []
  async *stream(options) {
    this.calls.push(options.messages)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ARC_' }
    await new Promise(resolve => setTimeout(resolve, 15))
    options.signal?.throwIfAborted()
    yield { type: 'text-delta', index: 0, text: 'OK' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ARC_OK' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('unmodified ACP wrapped through public Stream: new, stream, export, seeded resume, close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-acp-'))
  const h = await harness(join(root, 'sessions'))
  const adapter = new FixtureAdapter()
  h.ctx.llm.registerAdapter(['fixture'], adapter)
  const frames = []
  let conn
  try {
    conn = await connect(h, frames)
    const first = await conn.agent.request('session/new', { cwd: root, mcpServers: [] })
    let finished = false
    const prompt = conn.agent.request('session/prompt', {
      sessionId: first.sessionId, prompt: [{ type: 'text', text: 'Remember ACP_MARKER_317' }],
    }).then(value => { finished = true; return value })
    // Observe a real native stream before prompt completion, rather than checking final text alone.
    for (let i = 0; i < 100 && !frames.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.ok(frames.length > 0)
    assert.equal(finished, false)
    assert.equal((await prompt).stopReason, 'end_turn')
    const checkpoint = await conn.agent.request('_dsh/checkpoint', { sessionId: first.sessionId })
    const second = await conn.agent.request('session/new', {
      cwd: root, mcpServers: [], _meta: { dshCheckpoint: checkpoint },
    })
    assert.notEqual(second.sessionId, first.sessionId)
    const inherited = await conn.agent.request('_dsh/checkpoint', { sessionId: second.sessionId })
    assert.deepEqual(inherited.messages, checkpoint.messages)
    await conn.agent.request('session/prompt', {
      sessionId: second.sessionId, prompt: [{ type: 'text', text: 'Continue' }],
    })
    assert.match(JSON.stringify(adapter.calls.at(-1)), /ACP_MARKER_317/)
    await conn.agent.request('session/close', { sessionId: second.sessionId })
    await assert.rejects(conn.agent.request('_dsh/checkpoint', { sessionId: second.sessionId }))
  } finally { await conn?.close(); await h.close(); await rm(root, { recursive: true, force: true }) }
})

test('ACP export cannot read an unrelated live session, and malformed seed does not create an agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-acp-owner-'))
  const h = await harness(join(root, 'sessions'))
  let conn, unrelated
  try {
    conn = await connect(h, [])
    const staged = await h.ctx.arc.stageCheckpoint(fixture(), root)
    unrelated = await h.ctx.agents.resume({ resumeSessionId: staged.sessionId })
    await assert.rejects(conn.agent.request('_dsh/checkpoint', { sessionId: staged.sessionId }))
    const before = h.ctx.agents.list().length
    await assert.rejects(conn.agent.request('session/new', {
      cwd: root, mcpServers: [], _meta: { dshCheckpoint: { version: 77 } },
    }))
    assert.equal(h.ctx.agents.list().length, before)
  } finally {
    await conn?.close(); await unrelated?.dispose(); await h.close(); await rm(root, { recursive: true, force: true })
  }
})

test('an ordinary tool needs no ARC dependency; one-shot allow/reject still passes through stock ACP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-plain-tool-'))
  const h = await harness(join(root, 'sessions'))
  let conn, runs = 0, asks = 0, allow = false
  class ToolAdapter extends FixtureAdapter {
    next = 0
    async *stream(options) {
      if (this.next++ % 2 === 0) {
        const block = { type: 'tool-call', id: 'plain-' + this.next, name: 'plain_echo', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else yield* super.stream(options)
    }
  }
  try {
    await h.ctx.plugin(Approval, {})
    h.ctx.llm.registerAdapter(['fixture'], new ToolAdapter())
    const ordinary = await h.ctx.plugin({ inject: ['tools'], apply(ctx) {
      ctx.tools.register(defineTool({ name: 'plain_echo', description: 'Fixture tool', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute() { runs++; return 'plain tool result' },
      }))
    } })
    h.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'plain_echo' ? { kind: 'ask', reason: 'fixture' } : next())
    conn = await connect(h, [], () => {
      asks++
      return { outcome: { outcome: 'selected', optionId: allow ? 'allow-once' : 'reject-once' } }
    })
    const { sessionId } = await conn.agent.request('session/new', { cwd: root, mcpServers: [] })
    const prompt = () => conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Run fixture tool' }] })
    assert.equal((await prompt()).stopReason, 'end_turn')
    assert.equal(asks, 1); assert.equal(runs, 0)
    allow = true
    assert.equal((await prompt()).stopReason, 'end_turn')
    assert.equal(asks, 2); assert.equal(runs, 1)
    await ordinary.dispose()
    assert.equal(h.ctx.arc.inspect().version, 1)
  } finally { await conn?.close(); await h.close(); await rm(root, { recursive: true, force: true }) }
})

test('cancellation reaches an active native prompt and a subsequent checkpoint remains readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-cancel-'))
  const h = await harness(join(root, 'sessions'))
  let conn, started
  const entered = new Promise(resolve => { started = resolve })
  class WaitingAdapter extends LlmAdapter {
    async *stream(options) {
      started()
      await new Promise(resolve => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', resolve, { once: true })
      })
      options.signal.throwIfAborted()
    }
  }
  h.ctx.llm.registerAdapter(['fixture'], new WaitingAdapter())
  try {
    conn = await connect(h, [])
    const { sessionId } = await conn.agent.request('session/new', { cwd: root, mcpServers: [] })
    const prompting = conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Wait' }] })
    await entered
    await assert.rejects(conn.agent.request('_dsh/checkpoint', { sessionId }))
    await conn.agent.notify('session/cancel', { sessionId })
    assert.equal((await prompting).stopReason, 'cancelled')
    assert.equal((await conn.agent.request('_dsh/checkpoint', { sessionId })).version, 1)
  } finally { await conn?.close(); await h.close(); await rm(root, { recursive: true, force: true }) }
})
