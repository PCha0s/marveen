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
import { SETTINGS_REGISTRY } from '../config-registry.js'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
  it('config.ts exports FLEET_PYTHON_VENV with the ~/.klaudia-venv default and tilde expansion', () => {
    expect(CONFIG).toContain("const _fleetVenvRaw = cfg('FLEET_PYTHON_VENV') ?? '~/.klaudia-venv'")
    expect(CONFIG).toContain("export const FLEET_PYTHON_VENV = _fleetVenvRaw.startsWith('~') ? join(homedir(), _fleetVenvRaw.slice(1)) : _fleetVenvRaw")
  })

  it('the config registry documents the key as a restart-requiring system string', () => {
    const entry = SETTINGS_REGISTRY.find((e) => e.key === 'FLEET_PYTHON_VENV')
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('string')
    expect(entry?.default).toBe('~/.klaudia-venv')
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

  it('channels.sh reads FLEET_PYTHON_VENV from .env without set -a and prepends <venv>/bin when it exists', () => {
    expect(CHANNELS_SH).toContain("FLEET_PYTHON_VENV=\"$(grep -E '^FLEET_PYTHON_VENV=' \"$INSTALL_DIR/.env\" | head -1 | cut -d= -f2-)\"")
    expect(CHANNELS_SH).toContain('FLEET_PYTHON_VENV="${FLEET_PYTHON_VENV:-~/.klaudia-venv}"')
    expect(CHANNELS_SH).toContain('if [ -d "$FLEET_PYTHON_VENV/bin" ]; then\n  export PATH="$FLEET_PYTHON_VENV/bin:$PATH"\nfi')
    // The venv block must not widen to `set -a && source .env` (that would export every secret).
    expect(CHANNELS_SH.slice(CHANNELS_SH.indexOf('# FLEETVENV923:'))).not.toContain('source "$INSTALL_DIR/.env"')
  })
})

describe('channels.sh venv block (executed)', () => {
  // Extract the block between the base PATH export and the end of the venv `if`,
  // run it under bash with a fake INSTALL_DIR/.env and HOME, and read PATH back.
  const start = CHANNELS_SH.indexOf('# FLEETVENV923:')
  const endMarker = 'export PATH="$FLEET_PYTHON_VENV/bin:$PATH"\nfi\n'
  const end = CHANNELS_SH.indexOf(endMarker, start) + endMarker.length
  const block = CHANNELS_SH.slice(start, end)

  function run(envLine: string | null, makeVenv: boolean, venvRel = '.klaudia-venv'): string {
    const home = mkdtempSync(join(tmpdir(), 'fleet-venv-'))
    try {
      const install = join(home, 'install')
      mkdirSync(install)
      if (envLine !== null) writeFileSync(join(install, '.env'), envLine + '\n')
      if (makeVenv) mkdirSync(join(home, venvRel, 'bin'), { recursive: true })
      const script = `INSTALL_DIR="${install}"\nexport PATH="/usr/bin:/bin"\n${block}\nprintf '%s' "$PATH"\n`
      return execFileSync('bash', ['-c', script], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' })
        .replace(home, '$HOME')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('prepends $HOME/.klaudia-venv/bin by default when the directory exists', () => {
    expect(run(null, true)).toBe('$HOME/.klaudia-venv/bin:/usr/bin:/bin')
  })

  it('leaves PATH alone when the venv directory is missing', () => {
    expect(run(null, false)).toBe('/usr/bin:/bin')
  })

  it('honours FLEET_PYTHON_VENV from .env, with tilde expansion', () => {
    expect(run('FLEET_PYTHON_VENV=~/other-venv', true, 'other-venv')).toBe('$HOME/other-venv/bin:/usr/bin:/bin')
  })

  it('does not export unrelated .env keys into the shell', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-venv-'))
    try {
      const install = join(home, 'install')
      mkdirSync(install)
      writeFileSync(join(install, '.env'), 'TELEGRAM_BOT_TOKEN=secret\nFLEET_PYTHON_VENV=~/.klaudia-venv\n')
      const script = `INSTALL_DIR="${install}"\n${block}\nprintf '%s' "\${TELEGRAM_BOT_TOKEN:-unset}"\n`
      const out = execFileSync('bash', ['-c', script], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' })
      expect(out).toBe('unset')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
