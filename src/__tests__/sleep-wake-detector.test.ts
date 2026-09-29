import { afterEach, describe, expect, it } from 'vitest'
import {
  detectClockJump,
  sleptInWindow,
  recordClockSample,
  systemSleptBetween,
  resetSleepWakeDetectorForTest,
  SLEEP_GAP_THRESHOLD_MS,
  SLEEP_SAMPLE_INTERVAL_MS,
  monotonicNowMs,
  type ClockSample,
  type WakeEvent,
} from '../web/sleep-wake-detector.js'
import { decideCatchUpSummaryDelivery } from '../web/schedule-runner.js'

// Tests for the machine sleep/wake detector (2026-09-02, kanban 83b8c4c3).
//
// The detector's job: turn "our setInterval could not fire for a long
// stretch" into a queryable fact, so wall-clock-based alert paths (stuck-task
// timeout, keepalive staleness) can tell operator-caused downtime (lid close,
// power off) apart from a genuine hang while running. Suppressed: the
// Telegram ping. Untouched: respawn / retry / kanban / log visibility.

afterEach(() => resetSleepWakeDetectorForTest())

// Sample helpers: `asleep` = the wall clock moved, the monotonic clock did
// not (host suspended); `stalled` = both moved together (event loop blocked).
const at = (wallMs: number, monoMs: number): ClockSample => ({ wallMs, monoMs })

describe('detectClockJump', () => {
  it('null previous sample (first ever sample) is never a jump', () => {
    expect(detectClockJump(null, at(1_000_000, 5_000))).toBeNull()
  })

  it('a normal sample cadence is not a jump', () => {
    expect(detectClockJump(at(0, 0), at(SLEEP_SAMPLE_INTERVAL_MS, SLEEP_SAMPLE_INTERVAL_MS))).toBeNull()
  })

  it('a wall-over-monotonic divergence just below the threshold is not a jump', () => {
    expect(detectClockJump(at(0, 0), at(SLEEP_GAP_THRESHOLD_MS - 1, 0))).toBeNull()
  })

  it('a divergence at the threshold (monotonic stood still: suspend) is a jump spanning [prev, now] on the wall clock', () => {
    const jump = detectClockJump(at(1000, 7000), at(1000 + SLEEP_GAP_THRESHOLD_MS, 7000))
    expect(jump).toEqual({ sleepStartMs: 1000, wakeMs: 1000 + SLEEP_GAP_THRESHOLD_MS })
  })

  it('a BACKWARD clock step (NTP correction) is not sleep', () => {
    expect(detectClockJump(at(1_000_000, 0), at(500_000, 15_000))).toBeNull()
  })

  // #1153 review, measured: a 70 s event-loop stall on an awake machine gave
  // wallMs 86001 = monoMs 86001, and the gap-only detector called it sleep.
  it('STALL = LOUD: the review measurement (wall 86001 = mono 86001) is not sleep', () => {
    expect(detectClockJump(at(0, 0), at(86_001, 86_001))).toBeNull()
  })

  it('STALL = LOUD: a stall of any length, both clocks together, is never sleep', () => {
    for (const gap of [SLEEP_GAP_THRESHOLD_MS, 10 * 60_000, 6 * 3_600_000]) {
      expect(detectClockJump(at(1000, 1000), at(1000 + gap, 1000 + gap))).toBeNull()
    }
  })

  it('sleep followed by a stall in the same sample gap still counts the sleep part', () => {
    // 2 h asleep (mono still) + 90 s stalled after the wake (both advance)
    expect(detectClockJump(at(0, 0), at(2 * 3_600_000 + 90_000, 90_000))).not.toBeNull()
  })

  it('real clocks: a genuine synchronous stall moves wall and monotonic together', () => {
    // A scaled-down replay of the review measurement on the real clocks: block
    // the event loop, then judge the sample pair with a threshold the stall
    // itself exceeds. A gap-only detector would call this sleep.
    const stallMs = 250
    const before = at(Date.now(), monotonicNowMs())
    const until = monotonicNowMs() + stallMs
    while (monotonicNowMs() < until) { /* busy-wait: the event loop is blocked */ }
    const after = at(Date.now(), monotonicNowMs())
    expect(after.wallMs - before.wallMs).toBeGreaterThanOrEqual(stallMs - 5)
    expect(detectClockJump(before, after, stallMs - 50)).toBeNull()
  })
})

describe('sleptInWindow', () => {
  const HOUR = 3_600_000
  const nap: WakeEvent = { sleepStartMs: 10 * HOUR, wakeMs: 12 * HOUR }

  it('no recorded events -> never slept (fail-safe: alerts behave as before)', () => {
    expect(sleptInWindow([], 0, 100 * HOUR)).toBe(false)
  })

  it('a window fully containing the sleep gap overlaps', () => {
    expect(sleptInWindow([nap], 9 * HOUR, 13 * HOUR)).toBe(true)
  })

  it('a window that merely BRUSHES the gap on either side overlaps', () => {
    // Stuck-check opened before the sleep, closed mid-sleep... (cannot really
    // happen mid-sleep, but the boundary math must not care)
    expect(sleptInWindow([nap], 9 * HOUR, 10 * HOUR)).toBe(true)
    // ...or opened during the gap's tail and closed after the wake.
    expect(sleptInWindow([nap], 12 * HOUR, 13 * HOUR)).toBe(true)
  })

  it('a window entirely before or entirely after the gap does not overlap', () => {
    expect(sleptInWindow([nap], 0, 10 * HOUR - 1)).toBe(false)
    expect(sleptInWindow([nap], 12 * HOUR + 1, 14 * HOUR)).toBe(false)
  })
})

describe('recordClockSample + systemSleptBetween (module state)', () => {
  it('regular sampling records nothing; systemSleptBetween stays false', () => {
    let t = 1_000_000
    for (let i = 0; i < 10; i++) {
      expect(recordClockSample(t, t)).toBeNull()
      t += SLEEP_SAMPLE_INTERVAL_MS
    }
    expect(systemSleptBetween(1_000_000, t)).toBe(false)
  })

  it('a sleep gap between samples is recorded and queryable', () => {
    const HOUR = 3_600_000
    const mono = 5_000
    recordClockSample(1_000_000, mono)
    recordClockSample(1_000_000 + SLEEP_SAMPLE_INTERVAL_MS, mono + SLEEP_SAMPLE_INTERVAL_MS)
    // Lid closed for two hours: the wall clock moves on, the monotonic does not.
    const wakeAt = 1_000_000 + SLEEP_SAMPLE_INTERVAL_MS + 2 * HOUR
    const jump = recordClockSample(wakeAt, mono + SLEEP_SAMPLE_INTERVAL_MS + 1)
    expect(jump).not.toBeNull()
    // The exact stuck-check shape: injectedAt just before the sleep, checked
    // just after the wake -- the window overlaps the gap.
    expect(systemSleptBetween(1_000_000, wakeAt + 1000)).toBe(true)
    // A window opened AFTER the wake has no gap in it -- a genuine hang there
    // must still alert.
    expect(systemSleptBetween(wakeAt + 1000, wakeAt + 10 * 60_000)).toBe(false)
  })

  it('with the detector never fed (webOnly / tests), every query is false', () => {
    expect(systemSleptBetween(0, Date.now())).toBe(false)
  })

  // STALL = LOUD, end to end through the module state and a consumer: after an
  // in-process stall longer than the threshold, nothing is recorded, so the
  // missed-schedule catch-up still goes to the channel (and the task-timeout /
  // keepalive guards, which ask the same systemSleptBetween, stay loud).
  it('STALL = LOUD: a 70 s event-loop stall records no event and the catch-up summary still reaches the channel', () => {
    const t0 = 1_000_000
    recordClockSample(t0, 40_000)
    recordClockSample(t0 + SLEEP_SAMPLE_INTERVAL_MS, 40_000 + SLEEP_SAMPLE_INTERVAL_MS)
    const stall = 70_000
    const after = t0 + SLEEP_SAMPLE_INTERVAL_MS + stall
    expect(recordClockSample(after, 40_000 + SLEEP_SAMPLE_INTERVAL_MS + stall)).toBeNull()
    expect(systemSleptBetween(t0, after + 1000)).toBe(false)
    expect(decideCatchUpSummaryDelivery(systemSleptBetween(t0, after + 1000))).toBe('channel')
  })

  it('...while the same gap with the monotonic clock standing still (sleep) is log-only', () => {
    const t0 = 1_000_000
    recordClockSample(t0, 40_000)
    const after = t0 + 70_000
    expect(recordClockSample(after, 40_000 + 5)).not.toBeNull()
    expect(decideCatchUpSummaryDelivery(systemSleptBetween(t0, after + 1000))).toBe('log')
  })

  it('the live detector samples the real monotonic clock (process.hrtime.bigint)', () => {
    const src = readFileSync(join(__dirname, '../web/sleep-wake-detector.ts'), 'utf-8')
    expect(src).toContain('process.hrtime.bigint()')
    expect(src).toMatch(/lastSample = \{ wallMs: Date\.now\(\), monoMs: monotonicNowMs\(\) \}/)
  })
})

// --- Fix-revert guard: the consumers actually consult the detector ---
//
// If either sleep guard were removed, the greps below turn RED. Verified by
// inspection: deleting the systemSleptBetween call in sendTaskTimeoutAlert or
// checkMainKeepaliveStaleness fails the corresponding assertion.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('fix-revert guard: alert paths are sleep-aware', () => {
  it('sendTaskTimeoutAlert consults systemSleptBetween before the channel send', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    const fnStart = src.indexOf('function sendTaskTimeoutAlert')
    expect(fnStart).toBeGreaterThan(0)
    const fnEnd = src.indexOf('\nexport const SCHEDULE_TICK_MS', fnStart)
    const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)
    const sleptIdx = fnBody.indexOf('systemSleptBetween(entry.injectedAt')
    const sendIdx = fnBody.indexOf('await sendSchedulerAlertMessage(')
    expect(sleptIdx, 'sleep guard missing from sendTaskTimeoutAlert').toBeGreaterThan(0)
    expect(sendIdx).toBeGreaterThan(sleptIdx)
    // The kanban 'waiting' move must NOT be short-circuited by the guard. It
    // lives in STAGE 1 (sendTaskInflightMainAgentNotice), deliberately -- see
    // the comment there -- so the board reflects the stuck state before any
    // owner alert is even considered. Pin both halves: the move is in stage 1
    // and stage 1 has no sleep gate, and stage 2 (this function) carries no
    // copy the guard could skip. (Review 2026-09-03: the earlier version of
    // this test anchored on stage 2 and failed on develop.)
    const stage1Start = src.indexOf('function sendTaskInflightMainAgentNotice')
    expect(stage1Start).toBeGreaterThan(0)
    const stage1Body = src.slice(stage1Start, fnStart)
    expect(stage1Body).toContain('markScheduledTaskKanbanWaiting(')
    expect(stage1Body).not.toContain('systemSleptBetween(')
    expect(fnBody).not.toContain('markScheduledTaskKanbanWaiting(')
  })

  it('checkMainKeepaliveStaleness suppresses the routine alert on sleep but keeps the respawn and the loop-breaker alert', () => {
    const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
    const fnStart = src.indexOf('function checkMainKeepaliveStaleness')
    expect(fnStart).toBeGreaterThan(0)
    const fnEnd = src.indexOf('\nexport function sendAlert', fnStart)
    const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)
    const sleptIdx = fnBody.indexOf('systemSleptBetween(now - ageMs, now)')
    expect(sleptIdx, 'sleep guard missing from checkMainKeepaliveStaleness').toBeGreaterThan(0)
    // the routine respawn alert is inside the !staleDueToSleep branch...
    expect(fnBody).toMatch(/if \(!staleDueToSleep\) \{\s*\n\s*sendRoutineAlert\('keepalive-respawn'/)
    // ...the loop-breaker alert (a real fault) is NOT gated by sleep: it comes first
    const holdIdx = fnBody.indexOf("'hold-and-alert'")
    expect(holdIdx).toBeGreaterThan(0)
    expect(holdIdx).toBeLessThan(sleptIdx)
    // ...while the respawn stays UNCONDITIONAL on sleep (self-healing keeps going).
    const respawnIdx = fnBody.indexOf('respawnMarveenSessionFresh()')
    expect(respawnIdx).toBeGreaterThan(sleptIdx)
    const betweenGuardAndRespawn = fnBody.slice(fnBody.indexOf('if (!staleDueToSleep)'), respawnIdx)
    expect(betweenGuardAndRespawn).not.toMatch(/return/)
  })
})
