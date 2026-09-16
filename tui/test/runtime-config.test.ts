/**
 * Runtime configuration tests: defaults, expansion, hyphen paths, and
 * runtime identity namespacing.
 */

import { strict as assert } from 'node:assert'
import { homedir } from 'node:os'
import { test } from 'node:test'
import { resolveRuntimeConfig, runtimeIdentity } from '../dist/runtime-config.js'

test('defaults use the dedicated hyphen paths, never ~/.dsh', () => {
  const config = resolveRuntimeConfig({ demo: false, cwd: undefined, dshHome: undefined, stateDir: undefined, dshExecutable: undefined })
  assert.equal(config.dshHome, `${homedir()}/.local/share/personal-dsh/runtime`)
  assert.equal(config.stateDir, `${homedir()}/.local/share/personal-dsh/tui`)
  assert.ok(!config.dshHome.endsWith('/.dsh'))
})

test('~ expansion resolves against the home directory', () => {
  const config = resolveRuntimeConfig({ demo: false, cwd: '~/proj', dshHome: '~/rt', stateDir: '~/st', dshExecutable: undefined })
  assert.equal(config.cwd, `${homedir()}/proj`)
  assert.equal(config.dshHome, `${homedir()}/rt`)
})

test('empty path options are rejected', () => {
  assert.throws(() => resolveRuntimeConfig({ demo: false, cwd: '  ', dshHome: undefined, stateDir: undefined, dshExecutable: undefined }))
})

test('relative cwd is resolved to an absolute path', () => {
  const config = resolveRuntimeConfig({ demo: false, cwd: 'rel/path', dshHome: undefined, stateDir: undefined, dshExecutable: undefined })
  assert.ok(config.cwd.startsWith('/'))
})

test('demo mode differs in identity from dsh mode', () => {
  const demo = resolveRuntimeConfig({ demo: true, cwd: '/w', dshHome: undefined, stateDir: undefined, dshExecutable: undefined })
  const dsh = resolveRuntimeConfig({ demo: false, cwd: '/w', dshHome: '/rt', stateDir: undefined, dshExecutable: undefined })
  assert.notEqual(runtimeIdentity(demo), runtimeIdentity(dsh))
})

test('two dsh homes never share identity', () => {
  const a = resolveRuntimeConfig({ demo: false, cwd: '/w', dshHome: '/rt-a', stateDir: undefined, dshExecutable: undefined })
  const b = resolveRuntimeConfig({ demo: false, cwd: '/w', dshHome: '/rt-b', stateDir: undefined, dshExecutable: undefined })
  assert.notEqual(runtimeIdentity(a), runtimeIdentity(b))
})

test('explicit ARC profile is preserved and path-like profile names are rejected', () => {
  const base = { demo: false, cwd: '/w', dshHome: '/rt', stateDir: '/st', dshExecutable: undefined }
  assert.equal(resolveRuntimeConfig({ ...base, arcProfile: 'arc-acp' }).arcProfile, 'arc-acp')
  assert.throws(() => resolveRuntimeConfig({ ...base, arcProfile: '../bad' }), /profile/)
})
