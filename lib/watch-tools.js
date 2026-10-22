/**
 * `dkitchen_watch`: one batch of GitHub activity, reported and then ended.
 *
 * The right shape for a tool is one batch per call: a call that never returned would hold its
 * turn open indefinitely, and the orchestrator can simply call it again. The state file keeps
 * the meaning it needs to — what has already been reported, and where the next batch starts —
 * so rerunning loses nothing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { defineTool } from './registry-access.js'
import * as github from './github.js'
import * as paths from './paths.js'
import * as watch from './watch.js'
import { LockBusy } from './locks.js'
import { resolveRoot } from './cwd.js'

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

export function registerWatchTool(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.tools.register(defineTool({
    name: 'dkitchen_watch',
    description: 'One batch of GitHub activity the orchestrator must handle: executor '
      + 'comments that finished or ask for it, comments from the user, status labels, new PRs, '
      + 'and executors that have gone quiet. Reads only; nothing is posted. Needs the gh CLI.',
    parameters: {
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
      since: { type: 'string', description: 'Start time for the first run (ISO, UTC; default: now)' },
      stale_hours: { type: 'number', description: 'Executor silence that counts as stale (default: 6)' },
      check_stale: { type: 'boolean', description: 'Include quiet executors (default: true)' },
      skip_issue: {
        type: 'array', items: { type: 'number' },
        description: 'Tickets to ignore; the orchestrator log ticket is always ignored',
      },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      if (!github.available()) {
        throw new Error('the gh CLI is not installed; dkitchen_watch needs it')
      }
      const root = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent, ctx })
      const config = resolveConfig(root.root)
      const repo = config.repository()
      const statePath = watch.defaultStatePath(repo)

      let release
      try {
        release = await watch.lockWatch(statePath)
      } catch (error) {
        if (error instanceof LockBusy) {
          throw new Error(`another watch is using ${statePath}; stop it before starting a new one`)
        }
        throw error
      }

      try {
        const started = github.stamp()
        const previous = readState(statePath)
        const since = previous?.since ?? args.since ?? started
        const seen = new Set(previous?.seen ?? [])
        const reported = new Set(previous?.stale ?? [])
        const skip = new Set(args.skip_issue ?? [])
        if (config.log.issue) skip.add(config.log.issue)
        // Label changes made while the last batch was being handled are the orchestrator's own.
        const labelsSince = previous ? maxStamp(since, started) : since

        const found = watch.collect({ config, repo, since, labelsSince, seen, skip, cwd: root.root })
        const quiet = args.check_stale === false ? [] : watch.stale({
          config, repo, hours: args.stale_hours ?? 6, reported, skip, cwd: root.root,
        })

        const items = [
          ...found.map((item) => ({ time: item.time, line: item.line, wakes: item.wakes })),
          ...quiet.map((item) => ({ time: item.time, line: item.line, wakes: true })),
        ].sort((a, b) => String(a.time).localeCompare(String(b.time)))

        const polled = github.stamp()
        const wakes = items.some((item) => item.wakes)
        if (wakes) {
          writeState(statePath, {
            since: polled,
            seen: found.filter((item) => String(item.time) >= polled).map((item) => item.line),
            stale: [...reported, ...quiet.map((item) => item.id)],
          })
          log('batch of', items.length, 'from', since, 'to', polled)
        }
        return {
          repo,
          since,
          polled,
          wakes,
          count: items.length,
          items: items.map((item) => item.line),
          advanced: wakes ? polled : null,
        }
      } finally {
        release()
      }
    },
  }))

  // The state file's location is worth a tool of its own: a user debugging a watch that keeps
  // reporting the same batch needs to see, and be able to reset, that file.
  ctx.tools.register(defineTool({
    name: 'dkitchen_watch_state',
    description: 'Where the watch state lives, and what it currently holds.',
    parameters: {
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
      reset: { type: 'boolean', description: 'Forget what has already been reported' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const root = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent, ctx })
      const config = resolveConfig(root.root)
      const repo = config.repository()
      const statePath = watch.defaultStatePath(repo)
      if (args.reset) {
        writeState(statePath, { since: github.stamp(), seen: [], stale: [] })
        return { path: statePath, reset: true }
      }
      return { path: statePath, state: readState(statePath) }
    },
  }))
}

function readState(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value), 'utf8')
  renameSync(temporary, path)
}

function maxStamp(a, b) {
  return String(a) >= String(b) ? a : b
}

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export { paths }
