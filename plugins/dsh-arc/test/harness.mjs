import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Llm, { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Projections from '@deepseek-ai/dsh-session-projection'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as arc from '../lib/index.js'

export const fixture = () => ({ version: 1, sourceCwd: '/original', messages: [
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember ARC_FIXTURE_729' }] }),
  createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [
    { type: 'tool-call', id: 'call-fixture', name: 'fixture_read', arguments: '{}' },
  ] }),
  createToolResultMessage({ callId: 'call-fixture', isError: false, content: [{ type: 'text', text: 'already read' }] }),
  createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Recorded.' }] }),
] })

export async function harness(root) {
  const ctx = new Context()
  const fibers = []
  try {
    for (const [plugin, config] of [
      [Agents], [Sessions], [Llm], [Tools], [Prompt, {}], [Projections],
      [Persistence, { root, compression: 'none' }], [Loop, { agents: [] }],
    ]) fibers.push(await ctx.plugin(plugin, config))
    const plugin = await ctx.plugin(arc)
    return { ctx, plugin, close: () => ctx.fiber.dispose() }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

