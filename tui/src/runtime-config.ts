/**
 * Runtime launch configuration and identity.
 *
 * The TUI never spawns a shell: it starts one pinned `dsh --profile acp`
 * subprocess with an explicit argv and an explicit environment. The runtime
 * home defaults to a dedicated directory that is NOT `~/.dsh`, so the user's
 * global installation and its data stay untouched.
 *
 * @module personal-dsh-tui/runtime-config
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The pinned upstream runtime this project is developed against. */
export const EXPECTED_DSH_VERSION = '0.1.5-rc.1'

/** Default dedicated runtime home (DSH_HOME for the spawned runtime). */
export const DEFAULT_RUNTIME_HOME = resolve(homedir(), '.local/share/personal-dsh/runtime')

/** Default TUI-owned UI state directory (transcripts, drafts, session index). */
export const DEFAULT_STATE_DIR = resolve(homedir(), '.local/share/personal-dsh/tui')

/** Resolved launch configuration for one TUI process. */
export interface RuntimeConfig {
  /** Opt into an installed ARC ACP profile; its runtime starts without the legacy module hook. */
  readonly arcProfile?: string
  /** How the runtime is launched. */
  readonly mode: 'dsh' | 'demo'
  /** Absolute workspace path passed as the ACP session cwd. */
  readonly cwd: string
  /** Absolute DSH_HOME for the runtime (dsh mode only). */
  readonly dshHome: string
  /** Absolute directory holding TUI-owned state. */
  readonly stateDir: string
  /** Absolute workspace default when the user passed none. */
  readonly workspace: string
  /**
   * Explicit dsh executable to launch (dsh mode only). When omitted the TUI
   * spawns the project-local pinned `node_modules/.bin/dsh`.
   */
  readonly dshExecutable: string | undefined
}

/** Parsed command-line options relevant to runtime configuration. */
export interface CliRuntimeOptions {
  readonly arcProfile?: string
  readonly demo: boolean
  readonly cwd: string | undefined
  readonly dshHome: string | undefined
  readonly stateDir: string | undefined
  readonly dshExecutable: string | undefined
}

/** Locate the project-pinned dsh executable shipped as a dependency. */
function pinnedDshExecutable(): string {
  // import.meta.url is a file:// URL; fileURLToPath handles spaces correctly.
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    // Built layout: …/tui/dist -> …/tui/node_modules/.bin/dsh
    resolve(here, '..', 'node_modules', '.bin', 'dsh'),
    // Repo-root invocations: …/tui/dist -> …/node_modules/.bin/dsh
    resolve(here, '..', '..', 'node_modules', '.bin', 'dsh'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] as string
}

/**
 * Resolve one launch configuration from parsed options.
 *
 * Every path is expanded (`~` allowed) and made absolute; an empty string is
 * rejected because an accidental empty `--cwd` would silently become the TUI's
 * own process directory.
 */
export function resolveRuntimeConfig(options: CliRuntimeOptions): RuntimeConfig {
  if (options.arcProfile !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.arcProfile)) {
    throw new Error('ARC profile 必须是字母、数字、下划线或连字符组成的名称')
  }
  const expand = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new Error('path options must not be empty')
    const expanded = trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? resolve(homedir(), trimmed.slice(2))
        : trimmed
    return resolve(expanded)
  }
  const cwd = expand(options.cwd) ?? process.cwd()
  const dshHome = expand(options.dshHome) ?? DEFAULT_RUNTIME_HOME
  const stateDir = expand(options.stateDir) ?? DEFAULT_STATE_DIR
  const dshExecutable = options.dshExecutable === undefined ? undefined : expand(options.dshExecutable)
  if (!isAbsolute(cwd)) throw new Error(`cwd must be absolute after expansion: ${cwd}`)
  if (!isAbsolute(dshHome)) throw new Error(`dsh home must be absolute after expansion: ${dshHome}`)
  if (!isAbsolute(stateDir)) throw new Error(`state directory must be absolute after expansion: ${stateDir}`)
  return {
    ...(options.arcProfile === undefined ? {} : { arcProfile: options.arcProfile }),
    mode: options.demo ? 'demo' : 'dsh',
    cwd,
    dshHome,
    stateDir,
    workspace: cwd,
    dshExecutable: options.demo ? undefined : dshExecutable ?? pinnedDshExecutable(),
  }
}

/**
 * Stable identity for one runtime endpoint, used to namespace stored state.
 *
 * Two different runtime homes (or a demo runtime versus a real one) must never
 * share session mirrors even when the workspace is identical, so reconnecting
 * cannot mix sessions across runtimes.
 */
export function runtimeIdentity(config: RuntimeConfig): string {
  const raw = config.mode === 'demo' ? 'demo' : `dsh\0${config.dshHome}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 24)
}
