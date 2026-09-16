/** Optional consumer of ARC and public human-command / TUI status capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { createHash } from 'node:crypto'
import './index.js'

export const name = 'arc-tui'
export const inject = ['arc', 'commands']
interface StatusPort { set(key: string, text: string, identity: Context): () => void }

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'arc',
    description: 'ARC runtime status and current-session checkpoint inspection',
    async handler({ agent, rawInput, signal }) {
      const action = rawInput.trim() || 'status'
      if (action === 'status') {
        const info = ctx.arc.inspect()
        return { kind: 'success', text: `ARC_READY v${info.version}\nCapabilities: ${info.capabilities.join(', ')}\nSession: ${agent.session.id}` }
      }
      if (action === 'checkpoint') {
        const checkpoint = await ctx.arc.exportCheckpoint(agent, signal)
        const json = JSON.stringify(checkpoint)
        return { kind: 'success', text: `ARC_CHECKPOINT_OK\nMessages: ${checkpoint.messages.length}\nBytes: ${Buffer.byteLength(json)}\nSHA256: ${createHash('sha256').update(json).digest('hex')}` }
      }
      return { kind: 'error', text: 'Usage: /arc status | /arc checkpoint' }
    },
  })
  // Optional, structural port: core ARC neither imports nor installs a particular renderer.
  ctx.inject(['tuiStatus'], statusCtx => {
    const status = statusCtx.get('tuiStatus') as StatusPort
    status.set('dsh-arc:runtime', 'ARC ready · /arc status · /arc checkpoint', statusCtx)
  })
}
