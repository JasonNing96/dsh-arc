/** In-process capability. Wire callers must authorize access before invoking it. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { checkpointSeed, exportCheckpoint, type Checkpoint } from './checkpoint.js'

export { type Checkpoint } from './checkpoint.js'
export const name = 'arc-runtime'
export const inject = ['agents', 'sessions', 'sessionPersistence']

export interface StagedSession {
  sessionId: SessionId
  cwd: string
}

/** Stable public seam for the experimental checkpoint capability, not a transport. */
export interface ArcRuntimeApi {
  inspect(): { version: 1; capabilities: readonly ['checkpoint-export', 'checkpoint-stage'] }
  exportCheckpoint(agent: Agent, signal?: AbortSignal): Promise<Checkpoint>
  stageCheckpoint(checkpoint: unknown, cwd: string, signal?: AbortSignal): Promise<StagedSession>
}

declare module '@deepseek-ai/cordis' {
  interface Context { arc: ArcRuntimeApi }
}

export class ArcRuntime extends Service implements ArcRuntimeApi {
  // Keep lifecycle state in a plain holder: Cordis service access is caller-traced.
  private readonly state = {
    closed: false,
    abort: new AbortController(),
    pending: new Set<Promise<unknown>>(),
  }

  constructor(ctx: Context) {
    super(ctx, 'arc')
    const state = this.state
    ctx.effect(() => async () => {
      state.closed = true
      state.abort.abort(new Error('ARC plugin unloaded'))
      await Promise.allSettled([...state.pending])
    })
  }

  inspect(): ReturnType<ArcRuntimeApi['inspect']> {
    this.assertOpen()
    return { version: 1, capabilities: ['checkpoint-export', 'checkpoint-stage'] }
  }

  private assertOpen(): void {
    if (this.state.closed) throw new Error('ARC plugin unloaded')
  }

  private track<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertOpen()
    const combined = AbortSignal.any([this.state.abort.signal, ...(signal ? [signal] : [])])
    combined.throwIfAborted()
    const pending = operation(combined)
    this.state.pending.add(pending)
    // Use both handlers instead of an unobserved rejected finally() promise.
    void pending.then(() => this.state.pending.delete(pending), () => this.state.pending.delete(pending))
    return pending
  }

  exportCheckpoint(agent: Agent, signal?: AbortSignal): Promise<Checkpoint> {
    return this.track(async combined => {
      // A caller supplies the exact authorized object, not an arbitrary wire id.
      if (this.ctx.agents.get(agent.session.id) !== agent) throw new Error('ARC source agent is not live')
      if (agent.status !== 'idle') throw new Error('ARC source agent is busy')
      return agent.runMaintenance(async maintenanceSignal => {
        const guard = AbortSignal.any([combined, maintenanceSignal])
        guard.throwIfAborted()
        await this.ctx.sessions.flush(agent.session)
        guard.throwIfAborted()
        return exportCheckpoint(agent.session)
      })
    }, signal)
  }

  /** Create a durable cold session; a surface owns its subsequent resume and drive. */
  stageCheckpoint(checkpoint: unknown, cwd: string, signal?: AbortSignal): Promise<StagedSession> {
    // Snapshot and validate before the first await; callers cannot change the seed in flight.
    if (!isAbsolute(cwd)) return Promise.reject(new Error('ARC target cwd must be absolute'))
    const seed = checkpointSeed(checkpoint, cwd)
    return this.track(async combined => {
      const resolvedCwd = await realpath(cwd)
      if (!(await stat(resolvedCwd)).isDirectory()) throw new Error('ARC target cwd must be a directory')
      combined.throwIfAborted()
      const sessionId = brandString<SessionId>(randomUUID())
      let handle: AgentHandle | undefined
      try {
        handle = await this.ctx.agents.create({ sessionId, meta: { cwd: resolvedCwd }, seed, signal: combined })
        combined.throwIfAborted()
        if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('ARC requires a durable session writer')
        combined.throwIfAborted()
      } finally {
        // Release the factory handle and persistence write lock before a surface resumes it.
        await handle?.dispose()
      }
      combined.throwIfAborted()
      return { sessionId, cwd: resolvedCwd }
    }, signal)
  }
}

export function apply(ctx: Context): void { new ArcRuntime(ctx) }
