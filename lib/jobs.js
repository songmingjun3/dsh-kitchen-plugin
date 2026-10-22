/**
 * Long jobs: run something in the background and wake the session when it settles.
 *
 * The harness already has both halves: `ctx.jobs` registers background work and announces its
 * settlement as an in-session notice, and `ctx.subprocess` runs the command. This module joins
 * them, and writes `runs.jsonl` so a job whose notice was missed is still accounted for.
 *
 * A job belongs to the agent that started it — the registry fences it by owner — so `logs`
 * and `stop` take the calling agent and cannot reach another session's work.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import * as paths from './paths.js'
import { exclusive } from './locks.js'

/** A job operation that failed in a way the model should see. */
export class JobError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JobError'
  }
}

/** The record file the board reads: one JSON line per lifecycle event. */
export function recordPath() {
  return paths.state('runs.jsonl')
}

/**
 * Append one record.
 *
 * The write is serialized and appended whole. A run record is larger than a pipe buffer, and
 * an unsynchronized append on Windows splices two writers' bytes into a line that no longer
 * parses, so the lock is not optional.
 */
export async function append(record) {
  const target = recordPath()
  mkdirSync(dirname(target), { recursive: true })
  await exclusive(`${target}.lock`, async () => {
    appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8')
  })
}

/**
 * The command a job runs, resolved for this platform.
 *
 * A bare name is resolved against PATH first, because `ctx.subprocess.spawn` wants an
 * executable it has verified rather than a guess.
 */
export function resolveCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new JobError('launch needs the command to run, as an array of arguments')
  }
  const argv = command.map((part) => String(part))
  const [program, ...rest] = argv
  if (program.includes('/') || program.includes('\\')) return [program, ...rest]
  return [program, ...rest]
}

/** Whether a job id names something the registry could have issued. */
export function isJobId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*-[0-9a-f]{16}$/.test(value)
}

/** One line of error text, safe to put in a tool result. */
export function describe(error) {
  if (!error) return 'unknown error'
  return String(error.message ?? error).split(/\s+/).join(' ').trim()
}
