/**
 * Demo ACP runtime: a small standalone agent that speaks ACP over stdio.
 *
 * It exists so the TUI's interaction layer (input, history, tools, cancel,
 * permissions, resume) can be exercised without model credentials or a real
 * dsh home. It simulates turn latency with timers, emits tool call lifecycle
 * updates, asks one permission question per flagged prompt, and persists
 * sessions to a JSON file so resume works across restarts.
 *
 * It is clearly labeled demo: every session it creates carries the word
 * "demo" in its responses, and the TUI renders a DEMO badge while connected.
 *
 * @module personal-dsh-tui/demo-runtime
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  agent as createAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

interface PersistedSession {
  sessionId: string
  cwd: string
  createdAt: number
  turns: number
}

/** Prompt markers understood by the demo agent. */
export const DEMO_MARKERS = {
  cancel: '[cancel]',
  fail: '[fail]',
  permit: '[permit]',
  think: '[think]',
} as const

/** Start the demo agent over the given stream (defaults to stdio). */
export function startDemoAgent(stream?: Stream): void {
  const storePath = process.env.DSH_TUI_DEMO_STORE ?? join(homedir(), '.local/share/personal-dsh/demo/sessions.json')
  const active = new Map<string, { cancelled: boolean }>()
  const sessionsFile = storePath

  const loadStore = async (): Promise<PersistedSession[]> => {
    try {
      return JSON.parse(await readFile(sessionsFile, 'utf8')) as PersistedSession[]
    } catch {
      return []
    }
  }
  const saveStore = async (store: PersistedSession[]): Promise<void> => {
    await mkdir(dirname(sessionsFile), { recursive: true })
    const temp = `${sessionsFile}.tmp`
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, sessionsFile)
  }

  const app = createAgentApp({ name: 'personal-dsh-tui-demo' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      _meta: { dshTuiAdapter: 1 },
      agentInfo: { name: 'personal-dsh-tui-demo', version: '0.1.0' },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      },
      authMethods: [],
    }))
    // Demo tests transport/UI only; real native context is verified by tui-relay-smoke.py.
    .onRequest('_dsh/checkpoint', value => value as { sessionId: string }, async ({ params }) => {
      const session = (await loadStore()).find(item => item.sessionId === params.sessionId)
      if (!session) throw new Error('unknown demo session')
      return { version: 1, sourceCwd: session.cwd, messages: [] }
    })
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const sessionId = randomUUID()
      active.set(sessionId, { cancelled: false })
      const store = await loadStore()
      store.push({ sessionId, cwd: params.cwd, createdAt: Date.now(), turns: 0 })
      await saveStore(store)
      return { sessionId, configOptions: [] }
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const store = await loadStore()
      const filtered = params.cwd !== undefined && params.cwd !== null
        ? store.filter(entry => entry.cwd === params.cwd)
        : store
      return {
        sessions: filtered
          .filter(entry => !active.has(entry.sessionId))
          .map(entry => ({
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            updatedAt: new Date(entry.createdAt).toISOString(),
          })),
      }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      const store = await loadStore()
      const entry = store.find(item => item.sessionId === params.sessionId)
      if (entry === undefined) {
        throw new RequestError(
          -32602,
          `session is not resumable: ${params.sessionId}`,
        )
      }
      if (entry.cwd !== params.cwd) {
        throw new RequestError(
          -32602,
          `session cwd does not match: ${params.cwd}`,
        )
      }
      active.set(params.sessionId, { cancelled: false })
      return { configOptions: [] }
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      active.delete(params.sessionId)
      return {}
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const text = params.prompt
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
      const state = active.get(params.sessionId)
      if (state === undefined) {
        throw new RequestError(-32602, `unknown session: ${params.sessionId}`)
      }
      state.cancelled = false
      const notify = (update: SessionNotification['update']): void => {
        void client.notify(methods.client.session.update, { sessionId: params.sessionId, update })
      }
      const wait = async (ms: number): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => { clearTimeout(timer); reject(new Error('aborted')) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
        if (state.cancelled || signal.aborted) throw new Error('aborted')
      }
      try {
        if (text.includes(DEMO_MARKERS.think)) {
          notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '演示思考过程：分析输入并规划回复。' } })
          await wait(80)
        }
        if (text.includes(DEMO_MARKERS.permit)) {
          const response = await client.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: { toolCallId: `demo-tool-${randomUUID().slice(0, 8)}`, title: 'demo: ask permission', kind: 'other', status: 'in_progress' },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          })
          if (response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'allow-once') {
            notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '权限被拒绝（demo），工具未执行。' } })
            return { stopReason: 'end_turn' }
          }
          notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '权限已批准（demo）。' } })
        }
        notify({
          sessionUpdate: 'tool_call',
          toolCallId: 'demo-tool-1',
          title: 'demo: echo',
          kind: 'other',
          status: 'in_progress',
          rawInput: { text },
        })
        await wait(120)
        if (signal.aborted) throw new Error('aborted')
        notify({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'demo-tool-1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: `已接收 ${String(text.length)} 个字符。` } }],
        })
        notify({ sessionUpdate: 'usage_update', used: 128, size: 8192 })
        if (text.includes(DEMO_MARKERS.fail)) {
          throw new Error('demo: simulated failure marker in prompt')
        }
        const words = text.trim().length === 0 ? ['（空输入）'] : text.trim().split(/\s+/)
        let sent = ''
        for (const word of words) {
          if (text.includes(DEMO_MARKERS.cancel)) {
            // Slow emission so a cancel can land mid-turn.
            await wait(300)
            if (signal.aborted) throw new Error('aborted')
          } else {
            await wait(30)
          }
          sent += `${word} `
          notify({ sessionUpdate: 'agent_message_chunk', messageId: 'demo-msg', content: { type: 'text', text: `${word} ` } })
        }
        const closing = `\n[DEMO runtime · no model] echo:${String(words.length)} 词；已发送 ${String(sent.length)} 字符。`
        notify({ sessionUpdate: 'agent_message_chunk', messageId: 'demo-msg', content: { type: 'text', text: closing } })
        return { stopReason: 'end_turn' }
      } catch (error) {
        if (signal.aborted || String(error).includes('aborted')) {
          return { stopReason: 'cancelled' }
        }
        throw new RequestError(-32603, `demo turn failed: ${String(error)}`)
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      const state = active.get(params.sessionId)
      if (state !== undefined) state.cancelled = true
    })

  const wire = stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  app.connect(wire)
}

/** CLI entry for the demo runtime subprocess. */
export function runDemoRuntime(): void {
  startDemoAgent()
}

// Subprocess entry: `node dist/demo-runtime.js`. The ACP stdio stream keeps
// the process alive while the connection is open.
if (process.env.DSH_TUI_DEMO === '1' && process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemoRuntime()
}
