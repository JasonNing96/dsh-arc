/**
 * End-to-end tests against the bundled demo runtime spawned as a real
 * subprocess: session lifecycle, prompt/updates/cancel, permission approve
 * and deny, resume across client restarts, and failure paths.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, afterEach } from 'node:test'
import { AcpClient, AcpError } from '../dist/acp-client.js'
import { StateStore } from '../dist/state-store.js'
import { DEMO_MARKERS } from '../dist/demo-runtime.js'
import { until } from './harness.ts'
import type { AcpEventHandlers, RequestPermissionResponse } from '../dist/acp-client.js'

const clients = new Set<AcpClient>()
afterEach(async () => {
  for (const client of clients) await client.dispose()
  clients.clear()
})
async function connectDemo(id: string, cwd: string, handlers: AcpEventHandlers): Promise<AcpClient> {
  const client = await AcpClient.connectDemo(id, cwd, handlers)
  clients.add(client)
  return client
}

interface Recording {
  updates: { sessionId: string; update: { sessionUpdate: string } & Record<string, unknown> }[]
  permissions: { sessionId: string; options: { optionId: string; kind: string }[] }[]
  disconnects: string[]
}

function recordingHandlers(decision: 'allow' | 'reject' | 'cancel' = 'cancel'): AcpEventHandlers & Recording {
  const updates: Recording['updates'] = []
  const permissions: Recording['permissions'] = []
  const disconnects: string[] = []
  return {
    updates,
    permissions,
    disconnects,
    onUpdate: (sessionId, update) => {
      updates.push({ sessionId, update: update as Recording['updates'][number]['update'] })
    },
    onRequestPermission: (sessionId, request, respond) => {
      permissions.push({
        sessionId,
        options: request.options.map(option => ({ optionId: option.optionId, kind: option.kind })),
      })
      const response: RequestPermissionResponse = decision === 'allow'
        ? { outcome: { outcome: 'selected', optionId: 'allow-once' } }
        : decision === 'reject'
          ? { outcome: { outcome: 'selected', optionId: 'reject-once' } }
          : { outcome: { outcome: 'cancelled' } }
      respond(response)
    },
    onDisconnect: (reason) => { disconnects.push(reason) },
  }
}

async function demoEnv(): Promise<{ store: StateStore; workspace: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-demo-'))
  const workspace = join(root, 'ws')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  const store = await StateStore.open(join(root, 'state'), 'demo')
  process.env.DSH_TUI_DEMO_STORE = join(root, 'demo-sessions.json')
  return {
    store,
    workspace,
    cleanup: async () => {
      await store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('demo: session create, prompt, updates, idle', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    assert.equal(client.connected, true)
    const sessionId = await client.newSession(env.workspace)
    assert.ok(sessionId.length > 0)
    const response = await client.prompt(sessionId, '你好 世界')
    assert.equal(response.stopReason, 'end_turn')
    const kinds = h.updates.map(update => update.update.sessionUpdate)
    assert.ok(kinds.includes('agent_message_chunk'), `chunks: ${String(kinds)}`)
    assert.ok(kinds.includes('tool_call'), `tool lifecycle: ${String(kinds)}`)
    assert.ok(kinds.includes('tool_call_update'), `tool completion: ${String(kinds)}`)
    const text = h.updates
      .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
      .map(update => (update.update as { content: { text?: string } }).content.text ?? '')
      .join('')
    assert.ok(text.includes('你好'), 'assistant text echoes input')
    assert.ok(text.includes('DEMO'), 'responses are clearly labeled demo')
    await client.dispose()
  } finally {
    await env.cleanup()
  }
})

test('demo: cancel mid-turn settles as cancelled and keeps partial output', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    const sessionId = await client.newSession(env.workspace)
    const turn = client.prompt(sessionId, `${DEMO_MARKERS.cancel} one two three four five six`)
    await until(() => h.updates.some(update => update.update.sessionUpdate === 'agent_message_chunk' && String((update.update.content as { text?: string })?.text).includes('one')), 3000, 'first word')
    await client.cancel(sessionId)
    const response = await turn
    assert.equal(response.stopReason, 'cancelled')
    const text = h.updates
      .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
      .map(update => (update.update as { content: { text?: string } }).content.text ?? '')
      .join('')
    assert.ok(text.includes('one'), 'partial output preserved after cancel')
    assert.ok(!text.includes('six '), 'later words not emitted after cancel')
    await client.dispose()
  } finally {
    await env.cleanup()
  }
})

test('demo: permission allow proceeds; reject denies', async () => {
  const env = await demoEnv()
  const allow = recordingHandlers('allow')
  try {
    const client = await connectDemo('demo', env.workspace, allow)
    const sessionId = await client.newSession(env.workspace)
    const response = await client.prompt(sessionId, `${DEMO_MARKERS.permit} 请执行`)
    assert.equal(response.stopReason, 'end_turn')
    assert.equal(allow.permissions.length, 1)
    const text = allow.updates
      .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
      .map(update => (update.update as { content: { text?: string } }).content.text ?? '')
      .join('')
    assert.ok(text.includes('权限已批准'), 'allow branch rendered')
    await client.dispose()
  } finally {
    await env.cleanup()
  }
  const reject = recordingHandlers('reject')
  const env2 = await demoEnv()
  try {
    const client = await connectDemo('demo', env2.workspace, reject)
    const sessionId = await client.newSession(env2.workspace)
    const response = await client.prompt(sessionId, `${DEMO_MARKERS.permit} 请执行`)
    assert.equal(response.stopReason, 'end_turn')
    const text = reject.updates
      .filter(update => update.update.sessionUpdate === 'agent_message_chunk')
      .map(update => (update.update as { content: { text?: string } }).content.text ?? '')
      .join('')
    assert.ok(text.includes('权限被拒绝'), 'reject branch rendered')
    await client.dispose()
  } finally {
    await env2.cleanup()
  }
})

test('demo: [fail] marker turns into a protocol error', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    const sessionId = await client.newSession(env.workspace)
    await assert.rejects(client.prompt(sessionId, `${DEMO_MARKERS.fail} boom`), (error: unknown) => {
      assert.ok(error instanceof AcpError)
      assert.match(error.message, /demo turn failed|simulated failure/)
      return true
    })
    await client.dispose()
  } finally {
    await env.cleanup()
  }
})

test('demo: close then list shows the closed session; resume restores it', async () => {
  const env = await demoEnv()
  const h1 = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h1)
    const sessionId = await client.newSession(env.workspace)
    await client.prompt(sessionId, '第一轮')
    // While active, session/list deliberately excludes it.
    const duringActive = await client.listSessions(env.workspace)
    assert.equal(duringActive.find(entry => entry.sessionId === sessionId), undefined)
    await client.closeSession(sessionId)
    const listed = await client.listSessions(env.workspace)
    assert.ok(listed.some(entry => entry.sessionId === sessionId), 'closed session becomes listable')
    await client.dispose()

    // New client (restart): resume the same session.
    const h2 = recordingHandlers()
    const client2 = await connectDemo('demo', env.workspace, h2)
    await client2.resumeSession(sessionId, env.workspace)
    const response = await client2.prompt(sessionId, '第二轮')
    assert.equal(response.stopReason, 'end_turn')
    await client2.dispose()
  } finally {
    await env.cleanup()
  }
})

test('demo: resume with wrong cwd is rejected', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    const sessionId = await client.newSession(env.workspace)
    await client.closeSession(sessionId)
    await assert.rejects(client.resumeSession(sessionId, '/definitely/not/the/workspace'), (error: unknown) => {
      assert.ok(error instanceof AcpError)
      assert.match(error.message, /cwd/)
      return true
    })
    await client.dispose()
  } finally {
    await env.cleanup()
  }
})

test('demo: unknown session resume is rejected', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    await assert.rejects(client.resumeSession('no-such-session', env.workspace), (error: unknown) => {
      assert.ok(error instanceof AcpError)
      assert.match(error.message, /not resumable|unknown/)
      return true
    })
    await client.dispose()
  } finally {
    await env.cleanup()
  }
})

test('demo: dispose kills the subprocess', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    await client.dispose()
    await until(() => h.disconnects.length > 0 || !client.connected, 3000, 'disconnect on dispose')
    assert.equal(client.connected, false)
  } finally {
    await env.cleanup()
  }
})

test('demo: thought chunks surface for [think]', async () => {
  const env = await demoEnv()
  const h = recordingHandlers()
  try {
    const client = await connectDemo('demo', env.workspace, h)
    const sessionId = await client.newSession(env.workspace)
    await client.prompt(sessionId, `${DEMO_MARKERS.think} 想一想`)
    assert.ok(h.updates.some(update => update.update.sessionUpdate === 'agent_thought_chunk'))
    await client.dispose()
  } finally {
    await env.cleanup()
  }
})
