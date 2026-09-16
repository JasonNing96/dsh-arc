/** Optional ACP surface composition. Uses the public Stream override; no source rewriting. */
import { Readable, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { apply as mountAcp, inject as acpInject, Config, type AcpConfig } from '@deepseek-ai/dsh-acp'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'
import './index.js'

export { Config }
export const name = 'arc-acp'
export const inject = [...acpInject, 'arc']
type Frame = Stream extends { readable: ReadableStream<infer T> } ? T : never
type Request = { method: string; params?: Record<string, any>; id?: string | number }
interface Pending { method: string; sessionId?: string; imported?: string }

export function apply(ctx: Context, config: AcpConfig): void {
  const external = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  const writer = external.writable.getWriter()
  const reader = external.readable.getReader()
  const pending = new Map<string | number, Pending>()
  const owned = new Map<string, Agent>()
  const operations = new Set<Promise<void>>()
  const abort = new AbortController()
  let input!: ReadableStreamDefaultController<Frame>
  let closed = false
  const incoming = new ReadableStream<Frame>({ start(controller) { input = controller } })
  const send = (value: unknown) => writer.write(value as Frame)
  const error = (id: string | number, message: string) => send({ jsonrpc: '2.0', id,
    error: { code: -32602, message: 'Invalid params', data: { details: message } } })

  const outgoing = new WritableStream<Frame>({
    async write(frame) {
      const value = frame as unknown as Record<string, any>
      const request = !('method' in value) ? pending.get(value.id) : undefined
      if (request) {
        pending.delete(value.id)
        if ('result' in value) {
          if (request.method === 'initialize') value.result = { ...value.result,
            _meta: { ...value.result._meta, dshTuiAdapter: 1, dshArcPlugin: 1 } }
          if (request.imported) value.result = { ...value.result, sessionId: request.imported }
          if (['session/new', 'session/resume'].includes(request.method)) {
            const id = request.imported ?? value.result.sessionId ?? request.sessionId
            const agent = ctx.agents.get(brandString(id))
            if (agent) owned.set(id, agent)
          }
          if (request.method === 'session/close' && request.sessionId) owned.delete(request.sessionId)
        }
      }
      await send(value)
    },
  })

  async function receive(frame: Frame): Promise<void> {
    const value = frame as unknown as Request
    const params = value.params ?? {}
    if (value.method === '_dsh/checkpoint' && value.id !== undefined) {
      const agent = typeof params.sessionId === 'string' ? owned.get(params.sessionId) : undefined
      if (!agent || [...pending.values()].some(request => request.method === 'session/prompt' && request.sessionId === params.sessionId)) {
        await error(value.id, 'Session is not owned by this connection, or a prompt is in flight')
        return
      }
      try {
        const checkpoint = await ctx.arc.exportCheckpoint(agent, abort.signal)
        await send({ jsonrpc: '2.0', id: value.id, result: checkpoint })
      } catch (cause) { await error(value.id, cause instanceof Error ? cause.message : String(cause)) }
      return
    }
    if (value.method && value.id !== undefined) {
      if (pending.has(value.id)) { await error(value.id, 'Duplicate request id'); return }
      const request: Pending = { method: value.method }
      if (typeof params.sessionId === 'string') request.sessionId = params.sessionId
      pending.set(value.id, request)
      if (value.method === 'session/new' && params._meta?.dshCheckpoint !== undefined) {
        try {
          if (typeof params.cwd !== 'string' || !Array.isArray(params.mcpServers)) throw new Error('cwd and mcpServers required')
          const staged = await ctx.arc.stageCheckpoint(params._meta.dshCheckpoint, params.cwd, abort.signal)
          request.imported = staged.sessionId
          // Upstream ACP owns model selection, MCP setup, permissions and the resumed handle.
          input.enqueue({ ...frame, method: 'session/resume', params: {
            sessionId: staged.sessionId, cwd: staged.cwd, mcpServers: params.mcpServers,
          } } as Frame)
        } catch (cause) {
          pending.delete(value.id)
          await error(value.id, cause instanceof Error ? cause.message : String(cause))
        }
        return
      }
    }
    if (!closed) input.enqueue(frame)
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (closed || owned.get(agent.session.id) !== agent) return
    void send({ jsonrpc: '2.0', method: '_dsh/stream', params: { sessionId: agent.session.id, frame } })
      .catch(() => { abort.abort(new Error('ARC stream output closed')) })
  })
  mountAcp(ctx, { ...config, stream: { readable: incoming, writable: outgoing } })
  const pump = (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        const operation = receive(value)
        operations.add(operation)
        void operation.then(() => operations.delete(operation), () => operations.delete(operation))
        // Reads remain live while imports/checkpoints wait, so cancellation can reach ACP.
        void operation.catch(() => { abort.abort(new Error('ARC transport failed')) })
      }
    } finally {
      closed = true
      abort.abort(new Error('ARC connection closed'))
      await Promise.allSettled([...operations])
      input.close()
    }
  })()
  void pump.catch(() => {})
  ctx.effect(() => async () => {
    closed = true
    abort.abort(new Error('ARC ACP plugin unloaded'))
    await reader.cancel().catch(() => {})
    await pump.catch(() => {})
    await writer.close().catch(() => {})
    owned.clear(); pending.clear()
  })
}
