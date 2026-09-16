import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, rename, symlink, readlink, copyFile, readdir, open, rm, chmod, access } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'

export const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
export const version = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version
export const engine = require.resolve('@deepseek-ai/dsh/lib/bin.js')
export const modules = dirname(dirname(dirname(require.resolve('@deepseek-ai/dsh/package.json'))))
export const homePath = (input) => resolve(input ?? process.env.DSH_ARC_HOME ?? join(homedir(), '.local/share/dsh-arc'))

export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')) }

export async function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

export function modelOptions(options) {
  const provider = options.provider, model = options.model
  if (!provider || !model) throw new Error('Provide --provider and --model.')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(provider) || /[\x00-\x1f]/.test(model)) throw new Error('Invalid provider/model.')
  const apiKeyEnv = options['api-key-env'] ?? 'DSH_ARC_API_KEY'
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error('Invalid --api-key-env variable name.')
  const from = options['from-dsh-home'] ? resolve(options['from-dsh-home']) : undefined
  const baseURL = options['base-url']
  if (!from) {
    if (!baseURL) throw new Error('Provide --base-url or --from-dsh-home.')
    const url = new URL(baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint; credentials do not belong in its URL.')
  }
  return { provider, model, apiKeyEnv, ...(from ? { fromDshHome: from } : { baseURL }) }
}

export async function config(home) {
  const value = await readJson(join(home, 'config.json'))
  if (value.schema !== 1 || value.product !== 'dsh-arc') throw new Error('Unsupported ARC configuration schema; no files were changed.')
  return value
}

export async function requireIdle(home) {
  const visit = async path => {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(path, entry.name))
      else if (entry.name === 'lock.json') throw new Error('Close ARC before changing installation or remote configuration (state lock exists).')
    }
  }
  await visit(join(home, 'state'))
}

/** Link only distribution bundles; DSH owns the shared installation fallback directory. */
async function linkModules(directory, dependencies, replace = false) {
  for (const name of Object.keys(dependencies)) {
    const target = join(directory, 'node_modules', name)
    let source
    for (const base of require.resolve.paths(name) ?? []) {
      const candidate = join(base, name)
      try {
        if ((await readJson(join(candidate, 'package.json'))).name === name) { source = candidate; break }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!source) throw new Error('Cannot locate installed bundle: ' + name)
    await mkdir(dirname(target), { recursive: true })
    try {
      const prior = await readlink(target)
      if (prior === source) continue
      if (!replace) throw new Error(`Module location changed (${target}); run dsh-arc upgrade after closing all sessions.`)
      const temporary = `${target}.${randomUUID()}.tmp`
      try { await symlink(source, temporary, 'dir'); await rename(temporary, target) }
      finally { await rm(temporary, { force: true }) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await symlink(source, target, 'dir')
    }
  }
}

async function createProfile(home, name, bundles, dependencies, replace = false) {
  const directory = join(home, 'profiles', name)
  await mkdir(directory, { recursive: true })
  await linkModules(directory, dependencies, replace)
  let prior = {}
  try { prior = await readJson(join(directory, 'package.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeJson(join(directory, 'package.json'), {
    ...prior,
    name: `dsh-arc-${name}`, private: true, version,
    dependencies: { ...prior.dependencies, ...dependencies },
    dsh: { ...prior.dsh, profile: { ...prior.dsh?.profile,
      bundles: [...new Set([...bundles, ...(prior.dsh?.profile?.bundles ?? [])])], patchReload: 'startup' } },
  })
}

async function installProfiles(home, replace = false, finalHome = home) {
  const runtime = join(home, 'runtime'), ui = join(home, 'ui'), archives = join(home, 'packages', version)
  for (const path of [runtime, ui, archives, join(home, 'state')]) await mkdir(path, { recursive: true, mode: 0o700 })
  const payload = await readJson(join(packageRoot, 'vendor/manifest.json'))
  const dependencies = {}
  for (const item of payload.packages) {
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(item.file)) throw new Error('Invalid distribution archive name.')
    const source = join(packageRoot, 'vendor', item.file), file = join(archives, item.file)
    const digest = createHash('sha256').update(await readFile(source)).digest('hex')
    if (digest !== item.sha256) throw new Error('Distribution archive hash mismatch: ' + item.file)
    await copyFile(source, file)
    const name = item.file.startsWith('dsh-tui-') ? '@deepseek-harness-tui/dsh-tui' : item.file.replace(/-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.tgz$/, '')
    dependencies[name] = `file:${join(finalHome, 'packages', version, item.file)}`
  }
  await createProfile(runtime, 'arc-runtime', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', 'dsh-arc', 'dsh-arc-acp'],
    Object.fromEntries(['dsh-arc', 'dsh-arc-acp'].map(name => [name, dependencies[name]])), replace)
  await createProfile(ui, 'arc-ui', ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', 'dsh-arc-execution'],
    Object.fromEntries(['@deepseek-harness-tui/dsh-tui', 'dsh-arc-execution'].map(name => [name, dependencies[name]])), replace)
}

export async function upgrade(home) {
  const saved = await config(home)
  await requireIdle(home)
  const lock = await open(join(home, '.initializing'), 'wx', 0o600)
  try {
    await installProfiles(home, true)
    await writeJson(join(home, 'config.json'), { ...saved, installedVersion: version })
  } finally { await lock.close(); await rm(join(home, '.initializing'), { force: true }) }
}

/** Only new, owned homes are initialized. Model settings and credentials are host-local. */
export async function initialize(home, options) {
  const model = modelOptions(options)
  await mkdir(home, { recursive: true, mode: 0o700 })
  if ((await readdir(home)).length) throw new Error('ARC home is not empty; choose a new --home. Existing sessions and settings were preserved.')
  const ownership = await open(join(home, '.initializing'), 'wx', 0o600)
  const stage = join(home, `.setup-${randomUUID()}`)
  const committed = []
  try {
    await mkdir(stage, { mode: 0o700 })
    const runtime = join(stage, 'runtime')
    await installProfiles(stage, false, home)
    if (model.fromDshHome) {
      await copyFile(join(model.fromDshHome, 'settings.yaml'), join(runtime, 'settings.yaml'))
      await chmod(join(runtime, 'settings.yaml'), 0o600)
      // Do not copy machine-level executable patches. Profile owns the selected model route.
      try {
        await access(join(model.fromDshHome, '.credentials.yaml'))
        await symlink(join(model.fromDshHome, '.credentials.yaml'), join(runtime, '.credentials.yaml'))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    } else {
      await writeJson(join(runtime, 'settings.yaml'), { 'agent-presets': { default: 'standard' }, 'llm-pi-ai': { providers: {
        [model.provider]: { displayName: model.provider, api: 'openai-completions', baseURL: model.baseURL, apiKeyEnv: model.apiKeyEnv,
          models: [{ id: model.model, name: model.model, contextWindow: 131072, maxTokens: 8192, reasoningEfforts: false }] },
      } } })
    }
    await writeJson(join(runtime, 'profiles/arc-runtime/cordis.patch.yml'), [{ id: 'acp', config: { provider: model.provider, model: model.model } }])
    await writeJson(join(stage, 'config.json'), { product: 'dsh-arc', schema: 1, installedVersion: version, model })
    // The config file is the initialization commit; no runtime can start before it exists.
    for (const name of ['runtime', 'ui', 'packages', 'state', 'config.json']) {
      await rename(join(stage, name), join(home, name)); committed.push(name)
    }
  } catch (error) {
    for (const name of committed.reverse()) await rm(join(home, name), { recursive: true, force: true })
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
    await ownership.close()
    await rm(join(home, '.initializing'), { force: true })
  }
}

export function launchEnvironment(home) {
  const env = { ...process.env, DSH_HOME: home, PATH: join(modules, '.bin') + ':' + dirname(process.execPath) + ':' + (process.env.PATH ?? '') }
  // Experimental loader hooks are not part of the distribution execution path.
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  return env
}

export async function runtimeConfig(home, workspace) {
  const installed = await config(home)
  if (installed.installedVersion !== version) throw new Error('Installed package version changed; close sessions and run dsh-arc upgrade.')
  if (!isAbsolute(workspace)) throw new Error('Workspace must be an absolute path.')
  return { cwd: workspace, dshHome: join(home, 'runtime'), node: process.execPath, entry: engine, arcProfile: 'arc-runtime' }
}

export async function startConfig(home, workspace) {
  await runtimeConfig(home, workspace)
  const local = { cwd: workspace, dshHome: join(home, 'runtime'), stateDir: join(home, 'state'), dshExecutable: engine, arcProfile: 'arc-runtime' }
  let remoteConfig
  try { await readFile(join(home, 'remote.json')); remoteConfig = join(home, 'remote.json') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  // The immutable launch patch is unique to this invocation, avoiding concurrent overwrite.
  const patch = join(home, `launch-${randomUUID()}.json`)
  await writeJson(patch, [
    { id: 'arc-execution', config: { local, ...(remoteConfig ? { remoteConfig } : {}) } },
    { id: 'dsh-tui', config: { driverId: 'arc', lang: 'zh', fullscreen: true, terminalImages: false } },
    { id: 'session-title-llm', disabled: true },
  ])
  return { command: [engine, '--profile', 'arc-ui', '--patch', patch], env: launchEnvironment(join(home, 'ui')), patch }
}
