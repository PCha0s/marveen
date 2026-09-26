// SILENTOLLAMA926 / JSONCLOBBER926 (card 035e46d0): failures of an external
// dependency, or of a config file, must leave at least one visible line, and a
// corrupt config file must never be silently replaced by a one-key object.
//
// Background: on 2026-09-24/25 Ollama was not installed on this host at all;
// generateEmbedding() failed on every call at debug level, backfillEmbeddings()
// returned 0 two nights running, and nobody could tell from the logs.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideEmbeddingFailureLevel, backfillNeedsWarning } from '../db.js'
import { readJsonObjectForWrite } from '../web/agent-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

describe('embedding backend failures are visible once per outage', () => {
  it('the first failure warns, repeats are debug, a success re-arms (pure rule)', () => {
    expect(decideEmbeddingFailureLevel(false)).toBe('warn')
    expect(decideEmbeddingFailureLevel(true)).toBe('debug')
  })

  it('a backfill with pending rows and zero embedded is the outage signature', () => {
    expect(backfillNeedsWarning(185, 0)).toBe(true)
    expect(backfillNeedsWarning(0, 0)).toBe(false)     // nothing to do: quiet
    expect(backfillNeedsWarning(185, 12)).toBe(false)  // backend answered: quiet
  })

  it('generateEmbedding and backfillEmbeddings are wired to the rules (fix-revert guard)', () => {
    const src = read('src/db.ts')
    const gen = src.slice(src.indexOf('export async function generateEmbedding'), src.indexOf('function cosineSimilarity'))
    expect(gen).toContain('decideEmbeddingFailureLevel(embeddingBackendWarned)')
    expect(gen).toContain('embeddingBackendWarned = false')   // success re-arms
    expect(gen).toContain("logger[level]")
    expect(gen).not.toMatch(/logger\.debug\(\{ err, embedUrl/)     // the old debug-only line is gone
    const bfStart = src.indexOf('export async function backfillEmbeddings')
    const backfill = src.slice(bfStart, src.indexOf('\nexport ', bfStart + 1))
    expect(backfill).toContain('if (backfillNeedsWarning(rows.length, count))')
    expect(backfill).toContain('logger.warn(')
  })
})

describe('readJsonObjectForWrite never clobbers an existing config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-for-write-'))
  const at = (name: string) => join(dir, name)

  it('a missing file is the normal first write: {}', () => {
    expect(readJsonObjectForWrite(at('missing.json'))).toEqual({})
  })

  it('an empty file counts as missing', () => {
    writeFileSync(at('empty.json'), '  \n')
    expect(readJsonObjectForWrite(at('empty.json'))).toEqual({})
  })

  it('a valid object is returned as-is', () => {
    writeFileSync(at('ok.json'), JSON.stringify({ model: 'x', team: { lead: 'a' } }))
    expect(readJsonObjectForWrite(at('ok.json'))).toEqual({ model: 'x', team: { lead: 'a' } })
  })

  it('a corrupt file throws and is left byte-identical (the write never happens)', () => {
    const corrupt = '{ "model": "x", "displayName": "Kigyo"  <-- half-written'
    writeFileSync(at('corrupt.json'), corrupt)
    expect(() => readJsonObjectForWrite(at('corrupt.json'))).toThrow(/not valid JSON; refusing to overwrite/)
    expect(readFileSync(at('corrupt.json'), 'utf-8')).toBe(corrupt)
  })

  it('a non-object (array / scalar) throws too', () => {
    writeFileSync(at('array.json'), '[1,2,3]')
    expect(() => readJsonObjectForWrite(at('array.json'))).toThrow(/not a JSON object/)
    writeFileSync(at('scalar.json'), '"just a string"')
    expect(() => readJsonObjectForWrite(at('scalar.json'))).toThrow(/not a JSON object/)
  })

  it('every read-modify-write config site goes through it (no silent parse-then-write left)', () => {
    const files = [
      'src/web/agent-config.ts', 'src/web/agent-team.ts', 'src/web/scheduled-tasks-io.ts',
      'src/web/routes/connectors.ts', 'src/web/routes/agents.ts',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, f).not.toMatch(/try \{ \w+ = JSON\.parse\(readFileOr\([^)]*\)\) \} catch \{/)
      expect(src, f).not.toMatch(/catch \{ \/\* overwrite \*\/ \}/)
    }
    // Thirteen writers in agent-config.ts, one each in the other four.
    expect(read('src/web/agent-config.ts').match(/= readJsonObjectForWrite\(configPath\)/g)).toHaveLength(13)
    expect(read('src/web/agent-team.ts')).toContain('config = readJsonObjectForWrite(configPath)')
    expect(read('src/web/scheduled-tasks-io.ts')).toContain('config = readJsonObjectForWrite(configPath)')
    expect(read('src/web/routes/connectors.ts')).toContain('mcpConfig = readJsonObjectForWrite(mcpPath)')
    expect(read('src/web/routes/agents.ts')).toContain('readJsonObjectForWrite(settingsPath)')
  })

  it('cleanup', () => { rmSync(dir, { recursive: true, force: true }) })
})

describe('hook_errlog: a swallowed hook failure leaves one line', () => {
  it('report() appends a timestamped line with hook, message and exception, and never raises', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-errlog-'))
    const logPath = join(dir, 'nested', 'hook-errors.log')
    try {
      const code = [
        'import sys, os',
        `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'hooks'))})`,
        'import hook_errlog',
        'hook_errlog.report("channel-inbox-drain", "drain failed, inbox left claimed for the next run", ValueError("boom"))',
        'hook_errlog.report("ledger-outbound", "no exception variant")',
        'print("alive")',
      ].join('\n')
      const out = execFileSync('python3', ['-c', code], { env: { ...process.env, HOOK_ERRLOG_PATH: logPath }, encoding: 'utf-8' })
      expect(out.trim()).toBe('alive')
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} \[channel-inbox-drain\] drain failed, inbox left claimed for the next run ValueError: boom$/)
      expect(lines[1]).toMatch(/\[ledger-outbound\] no exception variant$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unwritable path is swallowed by report() itself (the hook must not die for the log)', () => {
    const code = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts', 'hooks'))})`,
      'import hook_errlog',
      'hook_errlog.report("x", "y", RuntimeError("z"))',
      'print("alive")',
    ].join('\n')
    const out = execFileSync('python3', ['-c', code], { env: { ...process.env, HOOK_ERRLOG_PATH: '/dev/null/impossible/hook-errors.log' }, encoding: 'utf-8' })
    expect(out.trim()).toBe('alive')
  })

  it('the three hooks call it on their swallowed external failures (fix-revert guard)', () => {
    expect(read('scripts/hooks/channel-inbox-drain.py')).toMatch(/except Exception as exc:[\s\S]{0,400}hook_errlog\.report\("channel-inbox-drain"/)
    expect(read('scripts/hooks/ledger-outbound.py')).toMatch(/except Exception as exc:[\s\S]{0,400}hook_errlog\.report\("ledger-outbound"/)
    const live = read('scripts/telegram-live-progress.py')
    expect(live).toMatch(/tmux has-session failed for/)
    expect(live).toMatch(/tmux capture-pane failed for/)
    expect(existsSync(join(ROOT, 'scripts', 'hooks', 'hook_errlog.py'))).toBe(true)
  })
})
