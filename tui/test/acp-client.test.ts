/**
 * Behavior tests for the ACP client: transport, request/update/cancel
 * lifecycle, permission handling, malformed messages, and process death.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { AcpClient, AcpError } from '../dist/acp-client.js'
import type { AcpEventHandlers } from '../dist/acp-client.js'
import { connectFake, until, type FakeRuntime } from './harness.ts'

function handlers(): AcpEventHandlers & {
  updates: { sessionId: string; update: unknown }[]
  permissions: { sessionId: string; request: unknown }[]
  disconnects: string[]
} {
  const updates: { sessionId: string; update: unknown }[] = []
  const permissions: { sessionId: string; request: unknown }[] = []
  const disconnects: string[] = []
  return {
    updates,
    permissions,
    disconnects,
    onUpdate: (sessionId, update) => { updates.push({ sessionId, update }) },
    onRequestPermission: (sessionId, request, respond) => {
      permissions.push({ sessionId, request })
      // Tests decide; default deny keeps the contract safe.
      respond({ outcome: { outcome: 'cancelled' } })
    },
    onDisconnect: (reason) => { disconnects.push(reason) },
  }
}

/** Answer the n-th pending client-visible request (id from sent lines). */
async function answer(fake: FakeRuntime, id: number | string | null, result: unknown): Promise<void> {
  fake.send({ jsonrpc: '2.0', id, result })
}

test('initialize completes and connection becomes ready', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  assert.equal(client.connected, true)
  const initialize = fake.sent.find(line => line.method === 'initialize')
  assert.ok(initialize !== undefined, 'initialize was sent')
  const disposal = client.dispose()
  assert.equal(client.dispose(), disposal, 'all owners await the same disposal')
  await disposal
})

test('newSession sends absolute cwd and returns the session id', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  const created = (async () => {
    const sessionId = await client.newSession('/tmp/work')
    return sessionId
  })()
  await until(() => fake.sent.some(line => line.method === 'session/new'))
  const request = fake.sent.find(line => line.method === 'session/new')
  assert.deepEqual((request?.params as { cwd: string }).cwd, '/tmp/work')
  await answer(fake, request?.id ?? null, { sessionId: 'sess-1', configOptions: [] })
  assert.equal(await created, 'sess-1')
  await client.dispose()
})

test('session/update notifications reach the handler with sessionId', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  fake.send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } },
    },
  })
  await until(() => h.updates.length > 0, 2000, 'update arrival')
  assert.equal(h.updates[0]?.sessionId, 'sess-1')
  const update = h.updates[0]?.update as { sessionUpdate: string }
  assert.equal(update.sessionUpdate, 'agent_message_chunk')
  await client.dispose()
})

test('prompt resolves with stopReason after the runtime responds', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  const turn = client.prompt('sess-1', '你好，世界')
  await until(() => fake.sent.some(line => line.method === 'session/prompt'))
  const request = fake.sent.find(line => line.method === 'session/prompt')
  const prompt = (request?.params as { prompt: { type: string; text: string }[] }).prompt
  assert.equal(prompt[0]?.type, 'text')
  assert.equal(prompt[0]?.text, '你好，世界')
  fake.send({ jsonrpc: '2.0', id: request?.id ?? null, result: { stopReason: 'end_turn' } })
  const response = await turn
  assert.equal(response.stopReason, 'end_turn')
  await client.dispose()
})

test('cancel sends a session/cancel notification', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  await client.cancel('sess-1')
  await until(() => fake.sent.some(line => line.method === 'session/cancel'))
  const request = fake.sent.find(line => line.method === 'session/cancel')
  assert.equal((request?.params as { sessionId: string }).sessionId, 'sess-1')
  await client.dispose()
})

test('permission requests surface through the handler and deny by default', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  const permissionId = 900
  // Runtime asks the client for a permission decision.
  fake.send({
    jsonrpc: '2.0',
    id: permissionId,
    method: 'session/request_permission',
    params: {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'call-1', title: 'run bash' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  await until(() => h.permissions.length > 0, 2000, 'permission arrival')
  await until(() => fake.sent.some(line => line.id === permissionId && line.result !== undefined))
  assert.deepEqual(fake.sent.find(line => line.id === permissionId)?.result, { outcome: { outcome: 'cancelled' } })
  await client.dispose()
})

test('explicit permission approve answers with the exact pending option', async () => {
  const h = handlers()
  let responder: ((response: { outcome: { outcome: string; optionId?: string } }) => void) | undefined
  const tracked: AcpEventHandlers = {
    onUpdate: h.onUpdate,
    onDisconnect: h.onDisconnect,
    onRequestPermission: (sessionId, request, respond) => {
      h.permissions.push({ sessionId, request })
      responder = respond
    },
  }
  const { client, fake } = await connectFake(tracked)
  fake.send({
    jsonrpc: '2.0',
    id: 901,
    method: 'session/request_permission',
    params: {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'call-2', title: 'write file' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  await until(() => responder !== undefined, 2000, 'responder captured')
  responder?.({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  await until(() => fake.sent.some(line => line.id === 901 && line.result !== undefined))
  assert.deepEqual(fake.sent.find(line => line.id === 901)?.result,
    { outcome: { outcome: 'selected', optionId: 'allow-once' } })
  await client.dispose()
  assert.equal(fake.sent.filter(line => line.id === 901).length, 1)
})

test('runtime error surfaces as AcpError with code and message', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  const turn = client.prompt('sess-none', 'x')
  await until(() => fake.sent.some(line => line.method === 'session/prompt'))
  const request = fake.sent.find(line => line.method === 'session/prompt')
  fake.send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32602, message: 'unknown session: sess-none' } })
  await assert.rejects(turn, (error: unknown) => {
    assert.ok(error instanceof AcpError)
    assert.equal(error.code, -32602)
    assert.match(error.message, /unknown session/)
    return true
  })
  await client.dispose()
})

test('malformed JSON receives a parse error; following valid updates still arrive', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  fake.send('this is not json\n')
  await until(() => fake.sent.some(line => (line.error as { code?: number })?.code === -32700))
  fake.send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'valid' } },
  } })
  await until(() => h.updates.length === 1)
  assert.equal(client.connected, true)
  await client.dispose()
})

test('stream kill (process death) reports disconnect once', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  fake.kill()
  await until(() => h.disconnects.length > 0, 3000, 'disconnect after kill')
  assert.equal(h.disconnects.length, 1)
  await client.dispose()
})

test('protocol version mismatch fails initialize', async () => {
  const h = handlers()
  const mismatch = connectFake(h, { initializeResult: { protocolVersion: 99, agentInfo: { name: 'x', version: '0' } } })
  await assert.rejects(mismatch, (error: unknown) => {
    assert.ok(error instanceof AcpError)
    assert.match(error.message, /协议版本/)
    return true
  })
})

test('requests after disconnect fail with a clear AcpError', async () => {
  const h = handlers()
  const { client, fake } = await connectFake(h)
  fake.kill()
  await until(() => h.disconnects.length > 0, 3000, 'disconnect')
  await assert.rejects(client.listSessions(), (error: unknown) => {
    assert.ok(error instanceof AcpError)
    assert.match(error.message, /不可用/)
    return true
  })
  await client.dispose()
})
