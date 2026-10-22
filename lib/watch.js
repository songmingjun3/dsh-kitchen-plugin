/**
 * Wait for GitHub activity the orchestrator must handle, report it, and exit.
 *
 * One batch per call, rather than a long-lived loop: a tool that never returned would hold its
 * turn open indefinitely, and the orchestrator can simply call this again. What a ticket is
 * doing is answered from `runs.jsonl`, which the job tools write, so a ticket counts as "busy"
 * only while a job for it is still running.
 *
 * Read-only: this never comments, never merges, and makes no model calls.
 */

import { readFileSync } from 'node:fs'

import * as github from './github.js'
import * as paths from './paths.js'
import * as tickets from './tickets.js'
import { acquire } from './locks.js'

/** The state file a watch keeps, so rerunning it loses nothing. */
export function defaultStatePath(repo) {
  return paths.state('watch', `${repo.replaceAll('/', '-')}.json`)
}

/**
 * Tickets whose launched job has not settled.
 *
 * `runs.jsonl` is append-only, so the last record per run decides: a `run_start` without a
 * later `run_stop` means the work is still running. A record file that cannot be read answers
 * an empty set — a watch that cannot tell is better off reporting than staying silent.
 */
export function busyTickets() {
  let text = ''
  try {
    text = readFileSync(paths.state('runs.jsonl'), 'utf8')
  } catch {
    return new Set()
  }
  const open = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!record || typeof record.run_id !== 'string') continue
    if (record.event === 'run_start') open.set(record.run_id, record)
    else if (record.event === 'run_stop' || record.event === 'task_exit') open.delete(record.run_id)
  }
  const numbers = new Set()
  for (const record of open.values()) {
    for (const match of String(record.name ?? '').matchAll(/#(\d+)/g)) {
      numbers.add(Number(match[1]))
    }
    for (const match of String(record.cwd ?? '').matchAll(/issue[-_]?(\d+)/g)) {
      numbers.add(Number(match[1]))
    }
  }
  return numbers
}

/** `(time, line, wakes)` for every item after the given times. */
export function collect({ config, repo, since, labelsSince, seen, skip, cwd }) {
  const awaitingLabel = config.labels.awaiting_user
  const awaiting = new Set(
    github.json([`api`, `repos/${repo}/issues?state=open&labels=${awaitingLabel}&per_page=100`], { cwd })
      .map((issue) => issue.number),
  )
  const { verifier, user, executor } = config.stations
  const found = []

  for (const item of github.newer(
    `repos/${repo}/issues/comments?since=${since}&sort=updated&direction=desc`, 'updated_at', since, { cwd },
  )) {
    const number = github.issueNumber(item.issue_url)
    const body = item.body
    const who = tickets.role(body, config)
    if (skip.has(number)) continue
    const wakes = who !== verifier
      && (who === verifier || who === user
        || (who === executor && tickets.executorWakes(body, awaiting.has(number), config)))
    if (who === verifier || who === user
        || (who === executor && tickets.executorWakes(body, awaiting.has(number), config))) {
      const kind = String(item.created_at) >= since ? `${who} comment` : `${who} edited a comment`
      const note = who === verifier ? ` (${verifier.toLowerCase()} reports separately; for reference)` : ''
      found.push({
        time: item.updated_at,
        line: `#${number} ${kind}${note}: ${tickets.summary(body, config)} ${item.html_url}`,
        wakes,
      })
    }
  }

  for (const event of github.newer(`repos/${repo}/issues/events?`, 'created_at', labelsSince, { cwd })) {
    const label = (event.label ?? {}).name ?? ''
    if (event.event === 'labeled' && label.startsWith(config.labels.prefix)
        && !skip.has(event.issue.number)) {
      found.push({
        time: event.created_at,
        line: `#${event.issue.number} label +${label} ${event.issue.html_url}`,
        wakes: true,
      })
    }
  }

  for (const pull of github.newer(
    `repos/${repo}/pulls?state=all&sort=created&direction=desc`, 'created_at', since, { pages: 1, cwd },
  )) {
    found.push({
      time: pull.created_at,
      line: `PR #${pull.number} opened: ${String(pull.title).slice(0, 80)} ${pull.html_url}`,
      wakes: true,
    })
  }

  // Times have one-second resolution, so the boundary second is rechecked and its already
  // reported lines dropped.
  const unique = new Map()
  for (const item of found) {
    if (!seen.has(item.line)) unique.set(item.line, item)
  }
  return [...unique.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)))
}

/**
 * In-progress tickets whose executor has gone quiet.
 *
 * A candidate needs no status label, an executor comment, and no running job. Whether the
 * executor is silent is decided by its *last* comment, not by the ticket's age.
 */
export function stale({ config, repo, hours, reported, skip, cwd }) {
  const cutoff = github.stamp(new Date(Date.now() - hours * 3_600_000))
  const candidates = github.json(['api', `repos/${repo}/issues?state=open&per_page=100`], { cwd })
    .filter((issue) => !('pull_request' in issue) && !skip.has(issue.number) && issue.comments > 0
      && String(issue.updated_at) < cutoff
      && !(issue.labels ?? []).some((label) => String(label.name).startsWith(config.labels.prefix)))
  if (candidates.length === 0) return []
  const busy = busyTickets()
  const found = []
  for (const issue of candidates) {
    if (busy.has(issue.number)) continue
    const last = github.json(
      ['api', `repos/${repo}/issues/${issue.number}/comments?per_page=1&page=${issue.comments}`], { cwd },
    ).at(-1)
    if (!last || reported.has(last.id)) continue
    if (tickets.role(last.body, config) !== config.stations.executor) continue
    if (tickets.stateAndWaiting(last.body, config)[0] !== config.status.in_progress) continue
    found.push({
      time: last.created_at,
      line: `#${issue.number} executor silent for over ${hours} hours, with no running job: `
        + `${tickets.summary(last.body, config)} ${last.html_url}`,
      id: last.id,
    })
  }
  return found
}

/** One poll of every source. Returns the items and whether any of them wakes the orchestrator. */
export function poll({ config, repo, since, labelsSince, seen, skip, cwd, staleHours, checkStale }) {
  const found = collect({ config, repo, since, labelsSince, seen, skip, cwd })
  const quiet = checkStale ? stale({ config, repo, hours: staleHours, reported: new Set(), skip, cwd }) : []
  return { found, quiet, wakes: found.some((item) => item.wakes) || quiet.length > 0 }
}

/**
 * Take the watch lock, so two watches never split one ticket stream.
 */
export async function lockWatch(statePath) {
  return acquire(`${statePath}.lock`, { blocking: false })
}
