/**
 * The long-job tools: launch, logs, stop.
 *
 * `ctx.jobs` gives the registration and the settlement announcement; `ctx.subprocess` runs
 * the command. Both are asked for, and a missing one is reported as such rather than failing
 * somewhere deeper: a profile without the job controller cannot start background work, and
 * saying so is more useful than a half-started process nobody can collect.
 */

import { defineTool } from './registry-access.js'
import * as jobs from './jobs.js'
import * as paths from './paths.js'

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Turn whatever a collected stream hands back into text.
 *
 * `readFrom` returns the buffered slice for that stream; across providers it may be a string,
 * a `Buffer`, or an object exposing `toString`. A missing or empty read is an empty string
 * rather than "undefined", because that is what the model would otherwise be shown.
 */
/**
 * The text of one buffered job chunk.
 *
 * A chunk names its stream and carries the bytes the producer appended; the exact member
 * holding them differs between providers, so each spelling is tried rather than assumed.
 */
function chunkText(chunk) {
  if (chunk === undefined || chunk === null) return ''
  if (typeof chunk === 'string') return chunk
  for (const key of ['text', 'data', 'chunk', 'bytes']) {
    const value = chunk[key]
    if (value === undefined || value === null) continue
    const text = decode(value)
    if (text !== '') return text
  }
  return ''
}

function decode(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  // `ctx.subprocess` collect reads answer `{text, nextOffset, lossy}`; `ctx.jobs.read`
  // chunks answer with the same `text` member. Anything else is reported as empty rather
  // than as `[object Object]`.
  if (typeof value.text === 'string') return value.text
  if (typeof value.toString === 'function') {
    const text = value.toString()
    return text === '[object Object]' ? '' : text
  }
  return ''
}

/**
 * The owner a job is registered against.
 *
 * `ctx.jobs.start` takes a **session id**, not an agent: the registry resolves it through
 * `ctx.agents.get(session)` and refuses a session with no live agent. Passing the agent
 * object instead produces `session "[object Object]" has no live agent`, which is what the
 * first run did.
 */
function ownerOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session && (session.id ?? session.meta?.id)
  if (typeof id !== 'string' || id === '') {
    throw new jobs.JobError(
      'this call has no live session, so a background job would have no owner to report to; '
      + 'call it from a session',
    )
  }
  return id
}

export function registerJobTools(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.tools.register(defineTool({
    name: 'dkitchen_launch',
    description: 'Run a long command in the background and wake this session when it exits. '
      + 'Returns at once with the job id; the settlement arrives as a session notice.',
    parameters: {
      name: { type: 'string', required: true, description: 'Job name, 1-64 letters, digits, underscores or hyphens' },
      command: { type: 'array', items: { type: 'string' }, required: true, description: 'The command and its arguments' },
      cwd: { type: 'string', description: "Working directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const owner = ownerOf(exec)
      if (!ctx.jobs || typeof ctx.jobs.start !== 'function') {
        throw new jobs.JobError(
          'this profile has no background-job registry; load @deepseek-ai/dsh-tool-jobs in it',
        )
      }
      if (!ctx.subprocess || typeof ctx.subprocess.spawn !== 'function') {
        throw new jobs.JobError('this profile has no subprocess provider; a job has nothing to run in')
      }
      const argv = jobs.resolveCommand(args.command)
      const cwd = args.cwd ?? process.cwd()

      let jobId
      try {
        jobId = ctx.jobs.start({
          owner,
          kind: 'dkitchen',
          label: `${args.name}: ${argv.join(' ')}`.slice(0, 200),
          // `run` must return its hooks synchronously: the registry binds `cancel` before any
          // work starts, and an async body would hand back a promise instead. The work itself
          // happens on the promise this starts, and its settlement is what the job records.
          run(handle) {
            const controller = new AbortController()
            handle.updateProgress('starting')
            let proc = null
            const work = (async () => {
              proc = ctx.subprocess.spawn({
                argv,
                cwd,
                stdio: {
                  stdin: 'ignore',
                  stdout: { maxBytes: 64 * 1024 },
                  stderr: { maxBytes: 64 * 1024 },
                },
                graceMs: 5000,
                signal: controller.signal,
              })
              const { exitCode } = await proc.done
              // `readFrom` is offset-based and returns the buffered slice for that stream.
              // Its shape is a buffer-like value, not a string, so it is decoded here and
              // never assumed: a stream that collected nothing reads as empty.
              // A collect read answers `{text, nextOffset, lossy}`; `decode` takes `.text`.
              const stdout = decode(proc.collected?.stdout?.readFrom?.(0))
              const stderr = decode(proc.collected?.stderr?.readFrom?.(0))
              if (stdout) handle.append(stdout)
              if (stderr) handle.append(stderr, { stream: 'stderr' })
              return { status: exitCode === 0 ? 'completed' : 'failed', detail: `exit code: ${exitCode ?? 'none'}` }
            })()
            return {
              cancel(reason) {
                controller.abort(reason)
                try { proc?.terminate?.() } catch { /* already gone */ }
              },
              // The registry reads `hooks.done`: a promise resolving to the outcome, whose
              // rejection it records as a failed job rather than losing the settlement.
              done: work,
            }
          },
        })
      } catch (error) {
        throw new jobs.JobError(`cannot start the job: ${jobs.describe(error)}`)
      }

      await jobs.append({
        event: 'run_start',
        run_id: jobId,
        name: args.name,
        cwd,
        command: argv,
        pid: process.pid,
        started_ns: Date.now() * 1_000_000,
      })
      log('launched', jobId)
      return { job: jobId, name: args.name, cwd, command: argv, running: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_logs',
    description: "A launched job's latest output.",
    parameters: {
      job: { type: 'string', required: true, description: 'The job id dkitchen_launch returned' },
      lines: { type: 'number', description: 'How many trailing lines to keep (default: 40)' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const owner = ownerOf(exec)
      if (!ctx.jobs || typeof ctx.jobs.list !== 'function') {
        throw new jobs.JobError('this profile has no background-job registry')
      }
      const mine = ctx.jobs.list(owner)
      const job = mine.find((entry) => entry.id === args.job)
      if (!job) {
        throw new jobs.JobError(
          `no job ${jobs.isJobId(args.job) ? args.job : JSON.stringify(args.job)} belongs to this `
          + `session; it knows: ${mine.map((entry) => entry.id).join(', ') || 'none'}`,
        )
      }
      const kept = Number.isInteger(args.lines) && args.lines > 0 ? args.lines : 40
      // `jobs.read` returns `{chunks, lossy, result?, job}`: the buffered output is the chunks
      // array, not a text field. Each chunk carries its stream and its text.
      let text = ''
      if (typeof ctx.jobs.read === 'function') {
        const read = ctx.jobs.read(args.job, owner)
        const chunks = read && Array.isArray(read.chunks) ? read.chunks : []
        text = chunks.map((chunk) => chunkText(chunk)).join('')
      }
      const lines = text.split(/\r?\n/)
      return {
        job: args.job,
        status: job.status ?? 'unknown',
        text: lines.slice(-kept).join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_stop',
    description: 'End a launched job and everything it started.',
    parameters: {
      job: { type: 'string', required: true, description: 'The job id dkitchen_launch returned' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const owner = ownerOf(exec)
      if (!ctx.jobs || typeof ctx.jobs.kill !== 'function') {
        throw new jobs.JobError('this profile has no background-job registry')
      }
      let outcome
      try {
        outcome = ctx.jobs.kill(args.job, owner, 'stopped by dkitchen_stop')
      } catch (error) {
        throw new jobs.JobError(`cannot stop ${args.job}: ${jobs.describe(error)}`)
      }
      await jobs.append({
        event: 'run_stop',
        run_id: args.job,
        outcome: String(outcome ?? 'requested'),
        at_ns: Date.now() * 1_000_000,
      })
      return { job: args.job, outcome: String(outcome ?? 'requested') }
    },
  }))

  // The board's RUN column reads the same record file, so a row can say how a job ended
  // without the model having collected it.
  ctx.tools.register(defineTool({
    name: 'dkitchen_run_status',
    description: 'How the launched jobs this session started ended, read from the run record.',
    parameters: {
      limit: { type: 'number', description: 'How many trailing records to consider (default: 50)' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(_args, exec) {
      void exec
      const target = jobs.recordPath()
      let text = ''
      try {
        text = String(await import('node:fs').then((fs) => fs.readFileSync(target, 'utf8')))
      } catch {
        text = ''
      }
      const records = text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const starts = records.filter((record) => record.event === 'run_start')
      return {
        stateRoot: paths.stateRoot(),
        started: starts.length,
        jobs: starts.slice(-10).map((record) => ({
          job: record.run_id,
          name: record.name,
          cwd: record.cwd,
        })),
      }
    },
  }))
}
