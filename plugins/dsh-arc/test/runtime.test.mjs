import { test } from 'node:test'
import assert from 'node:assert/strict'
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

import { fixture, harness } from './harness.mjs'

test('two independent native harnesses preserve context through durable stage/resume, without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-plugin-'))
  const left = await harness(join(root, 'left'))
  const right = await harness(join(root, 'right'))
  const work = join(root, 'workspace')
  await mkdir(work)
  let requests = 0, toolRuns = 0
  left.ctx.on('llm/request', () => { requests++ })
  right.ctx.on('llm/request', () => { requests++ })
  left.ctx.on('tools/result', () => { toolRuns++ })
  right.ctx.on('tools/result', () => { toolRuns++ })
  let source, target
  try {
    const original = fixture()
    const staged = await left.ctx.arc.stageCheckpoint(original, work)
    assert.equal(left.ctx.agents.get(staged.sessionId), undefined, 'staging releases the live handle')
    assert.equal(left.ctx.sessions.get(staged.sessionId), undefined)
    source = await left.ctx.agents.resume({ resumeSessionId: staged.sessionId })
    const portable = await left.ctx.arc.exportCheckpoint(source.agent)
    assert.deepEqual(portable.messages, original.messages)
    const imported = await right.ctx.arc.stageCheckpoint(portable, work)
    target = await right.ctx.agents.resume({ resumeSessionId: imported.sessionId })
    assert.notEqual(imported.sessionId, staged.sessionId)
    assert.deepEqual((await right.ctx.arc.exportCheckpoint(target.agent)).messages, original.messages)
    assert.equal(requests, 0, 'staging must not request a model')
    assert.equal(toolRuns, 0, 'historical tool calls must not execute')
    // Export does not revoke or dispose a source owned by another surface.
    assert.equal(left.ctx.agents.get(staged.sessionId), source.agent)
  } finally {
    await target?.dispose(); await source?.dispose()
    await right.close(); await left.close(); await rm(root, { recursive: true, force: true })
  }
})

test('unload withdraws the service, rejects stale handles, and leaves unrelated services available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-lifecycle-'))
  const h = await harness(root)
  try {
    const service = h.ctx.arc
    const toolsName = h.ctx.tools.name
    assert.equal(service.inspect().version, 1)
    await h.plugin.dispose()
    assert.equal(h.ctx.get('arc'), undefined)
    assert.throws(() => service.inspect(), /unloaded/)
    assert.equal(h.ctx.tools.name, toolsName)
    const reload = await h.ctx.plugin(arc)
    assert.equal(h.ctx.arc.inspect().version, 1)
    await reload.dispose()
  } finally { await h.close(); await rm(root, { recursive: true, force: true }) }
})

test('invalid data, foreign agents, concurrent maintenance and pre-cancelled imports fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-boundary-'))
  const h = await harness(join(root, 'sessions'))
  let handle
  try {
    assert.throws(() => h.ctx.arc.stageCheckpoint({}, root), /检查点/)
    await assert.rejects(h.ctx.arc.stageCheckpoint(fixture(), 'relative'), /absolute/)
    assert.throws(() => h.ctx.arc.stageCheckpoint(fixture(), root, AbortSignal.abort()), /abort/i)
    await assert.rejects(h.ctx.arc.exportCheckpoint({ session: { id: 'foreign' } }), /not live/)
    const staged = await h.ctx.arc.stageCheckpoint(fixture(), root)
    handle = await h.ctx.agents.resume({ resumeSessionId: staged.sessionId })
    let release
    const held = handle.agent.runMaintenance(() => new Promise(resolve => { release = resolve }))
    try { await assert.rejects(h.ctx.arc.exportCheckpoint(handle.agent), /maintenance|idle|busy|active work/i) }
    finally { release(); await held }
  } finally { await handle?.dispose(); await h.close(); await rm(root, { recursive: true, force: true }) }
})

test('unload drains an in-flight checkpoint and rejects it without disposing the source owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-unload-flight-'))
  const h = await harness(join(root, 'sessions'))
  let handle, release
  try {
    const staged = await h.ctx.arc.stageCheckpoint(fixture(), root)
    handle = await h.ctx.agents.resume({ resumeSessionId: staged.sessionId })
    let entered
    const flushing = new Promise(resolve => { entered = resolve })
    const remove = h.ctx.on('session/flush', () => {
      entered()
      return new Promise(resolve => { release = resolve })
    })
    const exporting = assert.rejects(h.ctx.arc.exportCheckpoint(handle.agent), /unloaded/)
    await flushing
    const disposing = h.plugin.dispose()
    // Removal must wait for the native durability barrier, not abandon it.
    release(); remove()
    await exporting; await disposing
    assert.equal(h.ctx.agents.get(staged.sessionId), handle.agent)
    assert.equal(handle.agent.status, 'idle')
  } finally { release?.(); await handle?.dispose(); await h.close(); await rm(root, { recursive: true, force: true }) }
})
