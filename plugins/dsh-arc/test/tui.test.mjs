import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Commands from '@deepseek-ai/dsh-commands'
import * as integration from '../lib/tui.js'
import { fixture, harness } from './harness.mjs'

test('public commands work without a TUI, preserve context, and withdraw on unload/reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-commands-'))
  const h = await harness(join(root, 'sessions'))
  let handle
  try {
    await h.ctx.plugin(Commands)
    const original = fixture()
    const staged = await h.ctx.arc.stageCheckpoint(original, root)
    handle = await h.ctx.agents.resume({ resumeSessionId: staged.sessionId })
    const agent = handle.agent
    const execute = line => h.ctx.commands.execute(agent, line, [], new AbortController().signal)
    let requests = 0
    h.ctx.on('llm/request', () => { requests++ })
    const other = await h.ctx.plugin({
      inject: ['commands'],
      apply(ctx) {
        ctx.commands.register({ name: 'other', description: 'Unrelated plugin', handler: () => ({ kind: 'success', text: 'OTHER_OK' }) })
      },
    })
    const ui = await h.ctx.plugin(integration)
    assert.equal(h.ctx.get('tuiStatus'), undefined, 'renderer is optional')
    assert.match((await execute('/arc')).result.text, /ARC_READY/)
    const checkpoint = (await execute('/arc checkpoint')).result
    assert.equal(checkpoint.kind, 'success')
    assert.match(checkpoint.text, /Messages: 4/)
    assert.doesNotMatch(checkpoint.text, /ARC_FIXTURE_729|already read/)
    assert.equal((await execute('/arc unknown')).result.kind, 'error')
    assert.equal(requests, 0)
    assert.deepEqual((await h.ctx.arc.exportCheckpoint(agent)).messages, original.messages,
      'command lifecycle must not pollute the model context')
    await ui.dispose()
    assert.equal(await execute('/arc'), undefined)
    assert.equal((await execute('/other')).result.text, 'OTHER_OK')
    assert.equal(h.ctx.arc.inspect().version, 1)
    const reload = await h.ctx.plugin(integration)
    assert.equal(h.ctx.commands.list(agent).filter(command => command.name === 'arc').length, 1)
    assert.match((await execute('/arc status')).result.text, /ARC_READY/)
    await reload.dispose()
    await h.plugin.dispose()
    assert.equal((await execute('/other')).result.text, 'OTHER_OK')
    assert.equal(h.ctx.agents.get(staged.sessionId), agent)
    await other.dispose()
  } finally {
    await handle?.dispose()
    await h.close()
    await rm(root, { recursive: true, force: true })
  }
})
