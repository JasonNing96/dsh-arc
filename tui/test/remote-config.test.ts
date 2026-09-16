import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseRemoteConfig, remoteSshArgs, remoteIdentity, shellQuote, loadRemoteConfig } from '../dist/remote-config.js'

const remote = { host: 'arc-test-server', cwd: '/srv/dsh/tui-workspace', dshHome: '/srv/dsh/tui-runtime',
  node: '/srv/dsh/node/bin/node', entry: '/srv/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' }

test('remote paths remain POSIX paths; host/unknown/credential fields are rejected', () => {
  assert.deepEqual(parseRemoteConfig(remote), remote)
  for (const value of [{ ...remote, host: '-oProxyCommand=bad' }, { ...remote, cwd: '~/project' },
    { ...remote, node: '/path\ncommand' }, { ...remote, apiKey: 'not-accepted' }]) {
    assert.throws(() => parseRemoteConfig(value))
  }
})

test('SSH uses strict host checking, no TTY, no forwarding, and bounded keepalives', () => {
  const args = remoteSshArgs(remote)
  for (const value of ['-T', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no',
    'ConnectTimeout=8', 'ServerAliveInterval=5', 'ServerAliveCountMax=2']) assert.ok(args.includes(value))
  assert.equal(args.at(-2), 'arc-test-server')
  assert.ok(args.at(-1)?.includes('DSH_HOME='))
})

test('remote shell quoting preserves quotes, spaces, substitutions and metacharacters literally', () => {
  const input = "/tmp/a ' $HOME `printf WRONG` $(printf WRONG); && name"
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(input)}`], { encoding: 'utf8' }), input)
})

test('runtime identity separates hosts and homes but stays stable across workspace paths', () => {
  assert.notEqual(remoteIdentity(remote), remoteIdentity({ ...remote, host: 'other' }))
  assert.notEqual(remoteIdentity(remote), remoteIdentity({ ...remote, dshHome: '/different' }))
  assert.equal(remoteIdentity(remote), remoteIdentity({ ...remote, cwd: '/different' }))
})

test('an absent optional config leaves local mode available; explicit missing config is an error', async () => {
  assert.equal(await loadRemoteConfig('/no-such-dsh-config.json', true), undefined)
  await assert.rejects(loadRemoteConfig('/no-such-dsh-config.json'), /无法读取服务器配置/)
})

test('an explicit ARC profile launches the remote plugin without the legacy import hook', () => {
  const parsed = parseRemoteConfig({ ...remote, arcProfile: 'arc-acp' })
  const command = remoteSshArgs(parsed).at(-1)!
  assert.ok(command.includes("--profile 'arc-acp'"))
  assert.ok(!command.includes('--import'))
  assert.throws(() => parseRemoteConfig({ ...remote, arcProfile: '../bad' }))
})

test('Docker keeps ACP unmodified, mounts explicit host paths and retains identity across image upgrades', () => {
  const container = parseRemoteConfig({ ...remote, cwd: '/workspace', dshHome: '/data/runtime', arcProfile: 'arc-runtime',
    docker: { image: 'ghcr.io/example/dsh-arc:1.0.0', workspace: '/srv/a b', dataDir: '/srv/arc', user: '1000:1000', envFile: '/srv/model.env' } })
  const command = remoteSshArgs(container).at(-1)!
  assert.match(command, /^exec 'docker' 'run' '--rm' '-i' '--init'/)
  assert.ok(command.includes('type=bind,src=/srv/a b,dst=/workspace'))
  assert.ok(command.includes("'--env-file' '/srv/model.env'"))
  assert.ok(!command.includes("'-t'"))
  assert.notEqual(remoteIdentity(container), remoteIdentity({ ...container, docker: { ...container.docker!, dataDir: '/srv/other' } }))
  assert.equal(remoteIdentity(container), remoteIdentity({ ...container, docker: { ...container.docker!, image: 'ghcr.io/example/dsh-arc:1.0.1' } }))
  for (const docker of [{ ...container.docker, image: '--privileged' }, { ...container.docker, user: 'root;bad' },
    { ...container.docker, workspace: '/srv/a,dst=/etc' }, { ...container.docker, privileged: true }]) {
    assert.throws(() => parseRemoteConfig({ ...container, docker }))
  }
  assert.throws(() => parseRemoteConfig({ ...container, cwd: '/host' }))
})
