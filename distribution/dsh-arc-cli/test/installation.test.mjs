import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize, upgrade, config, readJson, runtimeConfig, startConfig, version, requireIdle } from '../src/installation.mjs'

const model = { provider: 'fixture', model: 'fixture', 'base-url': 'http://127.0.0.1:1/v1' }

test('initialization uses persistent paths; repeated init preserves model configuration and session files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-install-')), home = join(root, 'home')
  try {
    await initialize(home, model)
    const before = await readFile(join(home, 'config.json'), 'utf8')
    await writeFile(join(home, 'state/session-fixture'), 'keep')
    await assert.rejects(initialize(home, { ...model, model: 'other' }), /not empty/)
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), before)
    const profile = await readJson(join(home, 'runtime/profiles/arc-runtime/package.json'))
    assert.ok(profile.dependencies['dsh-arc'].startsWith('file:' + home + '/packages/'))
    assert.ok(!JSON.stringify(profile).includes('.setup-'))
    await upgrade(home)
    assert.equal(await readFile(join(home, 'state/session-fixture'), 'utf8'), 'keep')
    assert.equal((await config(home)).installedVersion, version)
    assert.equal((await runtimeConfig(home, '/workspace')).arcProfile, 'arc-runtime')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed init removes only its staged files and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-failed-init-')), home = join(root, 'home')
  try {
    await assert.rejects(initialize(home, { ...model, 'from-dsh-home': join(root, 'missing') }), /ENOENT/)
    assert.deepEqual(await readdir(home), [])
    await initialize(home, model)
    assert.equal((await config(home)).schema, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('upgrade keeps user bundles and patches, refuses active sessions, and preserves future schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-upgrade-')), home = join(root, 'home')
  try {
    await initialize(home, model)
    const file = join(home, 'runtime/profiles/arc-runtime/package.json'), profile = await readJson(file)
    profile.dsh.profile.bundles.push('user-plugin'); profile.dependencies['user-plugin'] = '1.2.3'
    await writeFile(file, JSON.stringify(profile))
    const patch = join(home, 'runtime/profiles/arc-runtime/cordis.patch.yml'), original = await readFile(patch, 'utf8')
    const locked = join(home, 'state/runtimes/fixture'); await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'lock.json'), '{}')
    await assert.rejects(upgrade(home), /Close ARC/)
    await rm(join(locked, 'lock.json'))
    await upgrade(home)
    assert.ok((await readJson(file)).dsh.profile.bundles.includes('user-plugin'))
    assert.equal((await readJson(file)).dependencies['user-plugin'], '1.2.3')
    assert.equal(await readFile(patch, 'utf8'), original)
    const future = { ...await config(home), schema: 2 }
    await writeFile(join(home, 'config.json'), JSON.stringify(future))
    await assert.rejects(upgrade(home), /Unsupported/)
    assert.equal((await readJson(join(home, 'config.json'))).schema, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('existing host credentials remain referenced and launch patches are invocation-specific', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-existing-')), source = join(root, 'source'), home = join(root, 'home')
  try {
    await mkdir(source)
    await writeFile(join(source, 'settings.yaml'), '{}')
    await writeFile(join(source, '.credentials.yaml'), 'synthetic-test-data')
    await initialize(home, { ...model, 'from-dsh-home': source })
    assert.equal(await readlink(join(home, 'runtime/.credentials.yaml')), join(source, '.credentials.yaml'))
    const a = await startConfig(home, '/project'), b = await startConfig(home, '/project')
    assert.notEqual(a.patch, b.patch)
    assert.equal((await readJson(a.patch))[0].config.local.stateDir, join(home, 'state'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
