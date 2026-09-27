// FLEETVENV923: the fleet Python venv's bin/ leads every agent launch PATH.
//
// Measured 2026-09-23 on the Mac mini: the Homebrew python3 carried zero
// packages, so every skill `python3` call (akc-report, cella's xlsx work, the
// document-skills scripts) import-failed, while a venv with the packages sat
// in ~/.klaudia-venv. Rather than sprinkle `~/.klaudia-venv/bin/python3` over
// every skill, the venv's bin/ is prepended ONCE, in the three places a launch
// PATH is built: startAgentProcess (sub-agents), channels.sh (main session boot)
// and the channel-monitor recovery relaunch.

import { describe, it, expect } from 'vitest'
import { fleetVenvPathPrefix } from '../web/agent-process.js'
import { resolveFleetVenvDir, fleetVenvBin } from '../fleet-venv.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_PROCESS = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
const CHANNEL_MONITOR = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
const CONFIG = readFileSync(join(__dirname, '..', 'config.ts'), 'utf-8')
const CHANNELS_SH = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')

describe('fleetVenvPathPrefix', () => {
  it('returns "<venv>/bin:" when the bin directory exists', () => {
    expect(fleetVenvPathPrefix('/Users/x/.klaudia-venv', (p) => p === '/Users/x/.klaudia-venv/bin')).toBe('/Users/x/.klaudia-venv/bin:')
  })

  it('returns "" when the bin directory is missing (a missing venv disables the prefix)', () => {
    expect(fleetVenvPathPrefix('/Users/x/.klaudia-venv', () => false)).toBe('')
  })

  it('returns "" for an empty venv setting', () => {
    expect(fleetVenvPathPrefix('', () => true)).toBe('')
  })

  it('refuses a path with a shell-active character instead of injecting it into the double-quoted export', () => {
    for (const bad of ['/Users/x/"venv', '/Users/x/$venv', '/Users/x/`venv', '/Users/x/\\venv']) {
      expect(fleetVenvPathPrefix(bad, () => true)).toBe('')
    }
  })

  it('accepts a path with a space (safe inside the double quotes)', () => {
    expect(fleetVenvPathPrefix('/Users/x/my venv', () => true)).toBe('/Users/x/my venv/bin:')
  })
})

describe('FLEETVENV923 wiring (source-level)', () => {
  it('config.ts resolves FLEET_PYTHON_VENV through fleet-venv.ts (the function channels.sh shares)', () => {
    expect(CONFIG).toContain('export const FLEET_PYTHON_VENV = resolveFleetVenvDir(PROJECT_ROOT, homedir(), process.env.CLAUDECLAW_ENV_DIR ?? PROJECT_ROOT)')
  })

  it('the config registry documents the key as a restart-requiring system string, OFF by default', () => {
    const entry = SETTINGS_REGISTRY.find((e) => e.key === 'FLEET_PYTHON_VENV')
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('string')
    // No install-specific directory ships upstream: an install with a venv sets the key.
    expect(entry?.default).toBe('')
    expect(entry?.requiresRestart).toBe(true)
    expect(entry?.secret).toBe(false)
  })

  it('startAgentProcess puts the venv prefix FIRST in the launch PATH', () => {
    expect(AGENT_PROCESS).toContain('const venvPathPrefix = fleetVenvPathPrefix()')
    expect(AGENT_PROCESS).toContain('export PATH="${venvPathPrefix}/opt/homebrew/bin:$HOME/.bun/bin:')
  })

  it('the channel-monitor recovery relaunch uses the same prefix first', () => {
    expect(CHANNEL_MONITOR).toContain('`export PATH="${fleetVenvPathPrefix()}/opt/homebrew/bin:$HOME/.bun/bin:')
  })

  it('channels.sh asks the shared helper, and no longer parses the key itself', () => {
    const block = CHANNELS_SH.slice(CHANNELS_SH.indexOf('# FLEETVENV923:'))
    expect(CHANNELS_SH).toContain('"$INSTALL_DIR/scripts/fleet-venv-prefix.mjs"')
    expect(CHANNELS_SH).not.toMatch(/grep -E '\^FLEET_PYTHON_VENV='/)
    // Never widen to `set -a && source .env` (that would export every secret).
    expect(block).not.toContain('source "$INSTALL_DIR/.env"')
  })
})

// The review's measurement, as an executed test: the SAME settings drive the
// TypeScript side (resolveFleetVenvDir + fleetVenvBin, what config.ts and the
// launchers use) and the real channels.sh block, which runs the real helper
// script against the real fleet-venv.ts / env-parse.ts, transpiled into the
// fixture's dist/. Every case must give the same PATH on both sides.
describe('channels.sh and the TypeScript launchers resolve FLEET_PYTHON_VENV the same way (executed)', () => {
  const REPO = join(__dirname, '..', '..')
  const start = CHANNELS_SH.indexOf('# FLEETVENV923:')
  const endMarker = 'esac\n'
  const block = CHANNELS_SH.slice(start, CHANNELS_SH.indexOf(endMarker, start) + endMarker.length)
  const transpile = (rel: string) => ts.transpileModule(readFileSync(join(REPO, 'src', rel), 'utf-8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const FLEET_JS = transpile('fleet-venv.ts')
  const PARSE_JS = transpile('env-parse.ts')
  const HELPER = readFileSync(join(REPO, 'scripts', 'fleet-venv-prefix.mjs'), 'utf-8')
  const NODE_DIR = dirname(process.execPath)
  const BASE = `${NODE_DIR}:/usr/bin:/bin`

  interface Case { env?: string; override?: unknown; venvs?: string[]; dist?: boolean }
  function run(c: Case): { shell: string; ts: string; log: string } {
    const home = mkdtempSync(join(tmpdir(), 'fleet-venv-'))
    try {
      const install = join(home, 'install')
      for (const d of ['dist', 'scripts', 'store']) mkdirSync(join(install, d), { recursive: true })
      writeFileSync(join(install, 'package.json'), '{"type":"module"}\n')
      if (c.dist !== false) {
        writeFileSync(join(install, 'dist', 'fleet-venv.js'), FLEET_JS)
        writeFileSync(join(install, 'dist', 'env-parse.js'), PARSE_JS)
      }
      writeFileSync(join(install, 'scripts', 'fleet-venv-prefix.mjs'), HELPER)
      if (c.env !== undefined) writeFileSync(join(install, '.env'), c.env.replaceAll('$HOME', home) + '\n')
      if (c.override !== undefined) {
        const ov = typeof c.override === 'string' ? c.override.replaceAll('$HOME', home) : c.override
        writeFileSync(join(install, 'store', 'config-overrides.json'), JSON.stringify({ FLEET_PYTHON_VENV: ov }))
      }
      for (const v of c.venvs ?? []) mkdirSync(join(home, v, 'bin'), { recursive: true })
      const script = `INSTALL_DIR="${install}"\nexport PATH="${BASE}"\n${block}\nprintf '%s' "$PATH"\n`
      const shell = execFileSync('bash', ['-c', script], { env: { HOME: home, PATH: BASE }, encoding: 'utf-8' })
      const tsPrefix = fleetVenvBin(resolveFleetVenvDir(install, home)).prefix
      let log = ''
      try { log = readFileSync(join(install, 'store', 'channels-failures.log'), 'utf-8') } catch { /* none */ }
      const norm = (s: string) => s.replaceAll(home, '$HOME')
      return { shell: norm(shell), ts: norm(tsPrefix + BASE), log: norm(log) }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
  const ON = (dir: string) => `$HOME/${dir}/bin:${BASE}`

  // [label, case, expected PATH]
  const CASES: Array<[string, Case, string]> = [
    ['no key: OFF by default, even with ~/.klaudia-venv present', { venvs: ['.klaudia-venv'] }, BASE],
    ['plain absolute path in .env', { env: 'FLEET_PYTHON_VENV=$HOME/myvenv', venvs: ['myvenv'] }, ON('myvenv')],
    ['double-quoted value in .env', { env: 'FLEET_PYTHON_VENV="$HOME/myvenv"', venvs: ['myvenv'] }, ON('myvenv')],
    ['single-quoted value in .env', { env: "FLEET_PYTHON_VENV='$HOME/myvenv'", venvs: ['myvenv'] }, ON('myvenv')],
    ['empty value in .env = off', { env: 'FLEET_PYTHON_VENV=', venvs: ['.klaudia-venv'] }, BASE],
    ['leading ~ in .env = home', { env: 'FLEET_PYTHON_VENV=~/other-venv', venvs: ['other-venv'] }, ON('other-venv')],
    ['set on the Settings page only (config-overrides.json)', { override: '$HOME/myvenv', venvs: ['myvenv'] }, ON('myvenv')],
    ['disabled on the Settings page (/nonexistent) beats .env', { override: '/nonexistent', env: 'FLEET_PYTHON_VENV=$HOME/myvenv', venvs: ['myvenv'] }, BASE],
    ['an EMPTY override does not count: .env applies (cfg() rule)', { override: '', env: 'FLEET_PYTHON_VENV=$HOME/myvenv', venvs: ['myvenv'] }, ON('myvenv')],
    ['configured but the directory is missing = off', { env: 'FLEET_PYTHON_VENV=$HOME/gone' }, BASE],
    ['a shell-active character is refused on both sides', { env: 'FLEET_PYTHON_VENV=$HOME/bad$venv', venvs: ['bad$venv'] }, BASE],
  ]

  it.each(CASES)('%s', (_label, c, want) => {
    const r = run(c)
    expect(r.shell).toBe(want)
    expect(r.ts).toBe(want)
  })

  it('a refused path is NAMED in channels-failures.log, not silently dropped', () => {
    expect(run({ env: 'FLEET_PYTHON_VENV=$HOME/bad$venv', venvs: ['bad$venv'] }).log).toContain('shell-active character')
  })

  it('no dist yet: no prefix, and the reason is named in channels-failures.log', () => {
    const r = run({ env: 'FLEET_PYTHON_VENV=$HOME/myvenv', venvs: ['myvenv'], dist: false })
    expect(r.shell).toBe(BASE)
    expect(r.log).toContain('fleet venv PATH prefix skipped')
  })

  it('does not export unrelated .env keys into the shell', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-venv-'))
    try {
      const install = join(home, 'install')
      mkdirSync(install)
      writeFileSync(join(install, '.env'), 'TELEGRAM_BOT_TOKEN=secret\nFLEET_PYTHON_VENV=~/.klaudia-venv\n')
      const script = `INSTALL_DIR="${install}"\n${block}\nprintf '%s' "\${TELEGRAM_BOT_TOKEN:-unset}"\n`
      const out = execFileSync('bash', ['-c', script], { env: { HOME: home, PATH: BASE }, encoding: 'utf-8' })
      expect(out).toBe('unset')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
