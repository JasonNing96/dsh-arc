#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { access, rm } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { config, engine, homePath, initialize, launchEnvironment, readJson, requireIdle, runtimeConfig, startConfig, upgrade, version, writeJson } from './installation.mjs'

const help = `DSH ARC ${version} — local / SSH / Docker runtime handoff

Usage:
  dsh-arc init --provider <route> --model <id> --base-url <url> [--api-key-env NAME]
  dsh-arc init --from-dsh-home <existing-home> --provider <route> --model <id>
  dsh-arc [start] [--workspace <directory>]
  dsh-arc doctor
  dsh-arc upgrade                 Activate this installed version; keep settings and sessions
  dsh-arc runtime                 ACP over stdio, for SSH/container launch
  dsh-arc runtime-config --workspace <absolute-directory>
  dsh-arc remote add <ssh-alias> --workspace <remote-absolute-directory> [--remote-command /path/dsh-arc]
  dsh-arc remote add <ssh-alias> --docker-image <image> --data-dir <host-path> --workspace <host-path> --user <uid:gid> [--env-file <host-path>]
  dsh-arc remote add <ssh-alias> --config <remote.json>
  dsh-arc remote remove           Disconnect configuration; preserve remote data

All commands accept --home <directory> (default: DSH_ARC_HOME or ~/.local/share/dsh-arc).
Initialize each host separately. Model credentials stay on their respective hosts.
This distribution includes dsh-TUI 0.10.1-arc.1.0.0; it is not an upstream TUI release.
`

async function child(command, args, env, cwd) {
  const processChild = spawn(command, args, { stdio: 'inherit', env, cwd })
  const forward = signal => { if (!processChild.killed) processChild.kill(signal) }
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    return await new Promise((resolveExit, reject) => {
      processChild.once('error', reject)
      processChild.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143)))
    })
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm) }
}

async function main() {
  const names = ['home', 'provider', 'model', 'base-url', 'api-key-env', 'from-dsh-home', 'workspace', 'config', 'remote-command', 'remote-home', 'docker-image', 'data-dir', 'user', 'env-file']
  const parsed = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(names.map(name => [name, { type: 'string' }])), help: { type: 'boolean' }, version: { type: 'boolean' },
  } })
  const options = parsed.values, [command = 'start', subcommand, alias] = parsed.positionals
  if (options.help) { console.log(help); return 0 }
  if (options.version) { console.log(version); return 0 }
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('v1.0 supports macOS/Linux; use Docker or WSL for other hosts.')
  const home = homePath(options.home), workspace = resolve(options.workspace ?? process.cwd())
  if (command === 'init') {
    await initialize(home, options)
    console.log(`Initialized ${home}\nModel credentials were not copied between hosts. Run dsh-arc doctor, then dsh-arc.`)
  } else if (command === 'upgrade') {
    await upgrade(home)
    console.log(`Activated ${version}; settings and session data were preserved.`)
  } else if (command === 'runtime-config') {
    console.log(JSON.stringify(await runtimeConfig(home, workspace)))
  } else if (command === 'doctor') {
    const value = await config(home)
    await access(engine)
    const result = { version, home, node: process.version, provider: value.model.provider, model: value.model.model,
      credentials: value.model.fromDshHome ? 'existing DSH configuration (not probed)' : process.env[value.model.apiKeyEnv] ? 'environment present' : `set ${value.model.apiKeyEnv}`,
      runtime: await runtimeConfig(home, workspace), modelRequests: 0 }
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'runtime') {
    await runtimeConfig(home, workspace)
    return child(process.execPath, [engine, '--profile', 'arc-runtime'], launchEnvironment(join(home, 'runtime')), workspace)
  } else if (command === 'start') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Start the TUI in an interactive terminal; use runtime for ACP stdio.')
    const launch = await startConfig(home, workspace)
    try { return await child(process.execPath, launch.command, launch.env, workspace) }
    finally { await rm(launch.patch, { force: true }) }
  } else if (command === 'remote') {
    await config(home)
    await requireIdle(home)
    if (subcommand === 'remove') {
      await rm(join(home, 'remote.json'), { force: true })
      console.log('Remote configuration removed. Remote files and sessions were preserved.')
    } else if (subcommand === 'add' && alias) {
      const { parseRemoteConfig, shellQuote } = await import('dsh-arc-execution/remote-config')
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(alias)) throw new Error('Use a valid SSH alias.')
      let input
      if (options.config) {
        input = await readJson(resolve(options.config))
      } else if (options['docker-image']) {
        input = { cwd: '/workspace', dshHome: '/data/runtime', node: '/usr/local/bin/node', entry: '/opt/dsh-arc/src/cli.mjs', arcProfile: 'arc-runtime',
          docker: { image: options['docker-image'], dataDir: options['data-dir'], workspace: options.workspace, user: options.user,
            ...(options['env-file'] ? { envFile: options['env-file'] } : {}) } }
      } else {
        if (!options.workspace?.startsWith('/')) throw new Error('Provide an absolute server --workspace.')
        const args = [options['remote-command'] ?? 'dsh-arc', 'runtime-config', '--workspace', options.workspace,
          ...(options['remote-home'] ? ['--home', options['remote-home']] : [])]
        const result = await promisify(execFile)('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
          '-o', 'ConnectTimeout=8', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', alias,
          'exec ' + args.map(shellQuote).join(' ')], { timeout: 20000, maxBuffer: 65536 })
        input = JSON.parse(result.stdout)
      }
      const remote = parseRemoteConfig({ ...input, host: alias })
      await writeJson(join(home, 'remote.json'), remote)
      console.log(`Registered ${alias}. Use /arc switch after starting the TUI.`)
    } else throw new Error('Use remote add <ssh-alias> --workspace <server-directory>, --config <file>, or remote remove.')
  } else throw new Error(`Unknown command: ${command}. Run dsh-arc --help.`)
  return 0
}

main().then(code => { process.exitCode = code }).catch(error => {
  console.error(`dsh-arc: ${error.message}`)
  process.exitCode = 1
})
