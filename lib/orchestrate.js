/**
 * The orchestrator's routine GitHub writes, each checked step by step.
 *
 * These are the actions the house rules say must happen in an exact order — a relay comments
 * only after delivery is confirmed, a merge happens only at the reviewed HEAD and only once
 * the executor is waiting for it — so the ordering and the refusals are deliberate rather
 * than incidental.
 */

import * as github from './github.js'
import * as tickets from './tickets.js'

/** Prepend the station signature unless the text already opens with it. */
export function signed(text, config) {
  const signature = config.signature(config.stations.orchestrator)
  const body = String(text).trim()
  return body.startsWith(signature.trimEnd()) ? body : signature + body
}

/** The body of one orchestrator log entry. */
export function logBody(items, pending, moment, config) {
  const stations = config.stations
  const hhmm = `${moment.toISOString().slice(11, 16)} UTC`
  const lines = [
    `${stations.signature(stations.orchestrator)}${hhmm}`,
    ...items.map((item) => `- ${item}`),
    `- ${config.log.pending}${stations.separator}${pending.join('; ') || config.status.none}`,
  ]
  return lines.join('\n')
}

/** Ticket numbers a PR body mentions, as #N or as a link to this repository. */
export function ticketReferences(body, repo, pr) {
  const links = new RegExp(`https://github\\.com/${escapeRegExp(repo)}/(?:issues|pull)/(\\d+)`, 'g')
  const numbers = new Set()
  for (const match of String(body ?? '').matchAll(/(?<![\w/&])#(\d+)\b/g)) {
    numbers.add(Number(match[1]))
  }
  for (const match of String(body ?? '').matchAll(links)) {
    numbers.add(Number(match[1]))
  }
  numbers.delete(pr)
  return [...numbers].sort((a, b) => a - b)
}

/**
 * The latest executor comment on a ticket: its status block, whether it waits on the
 * orchestrator, and its URL.
 */
export function executorStatus({ repo, issue, cwd, config }) {
  const comments = github.records(`repos/${repo}/issues/${issue}/comments?per_page=100`, { cwd })
  const fromExecutor = comments.filter(
    (entry) => tickets.role(entry.body, config) === config.stations.executor,
  )
  if (fromExecutor.length === 0) return null
  const latest = fromExecutor.at(-1)
  const names = config.status.fields
  const block = latest.body
    .split(/\r?\n/)
    .slice(0, names.length)
    .filter((line) => line.trim() !== '')
    .join('\n')
  const [, waiting] = tickets.stateAndWaiting(latest.body, config)
  const ready = !waiting.startsWith(config.status.none)
    && waiting.includes(config.stations.orchestrator)
  return { block, url: latest.html_url, ready }
}

/**
 * Merge a reviewed PR at the reviewed HEAD.
 *
 * Every refusal happens before the merge, so a failure leaves the PR untouched and says why.
 */
export function merge({ pr, sha, ticket, noTicket, repo, cwd, config, say }) {
  const view = () => github.json(
    ['pr', 'view', String(pr), '--repo', repo, '--json',
      'isDraft,state,headRefOid,mergeCommit,body'],
    { cwd },
  )
  let pull = view()
  if (pull.state === 'MERGED') {
    return say(`PR #${pr} was already merged as ${pull.mergeCommit?.oid}; nothing done`)
  }
  if (!String(pull.headRefOid).startsWith(sha)) {
    return say(`PR #${pr} HEAD is now ${pull.headRefOid}, not the reviewed ${sha}; review it again`)
  }
  if (pull.isDraft) {
    return say(`PR #${pr} is a draft and cannot be merged; mark it ready with gh pr ready first`)
  }
  if (!noTicket) {
    let number = ticket
    let status = null
    if (number === undefined || number === null) {
      const found = new Map()
      for (const candidate of ticketReferences(pull.body, repo, pr)) {
        const status = executorStatus({ repo, issue: candidate, cwd, config })
        if (status) found.set(candidate, status)
      }
      if (found.size !== 1) {
        const listed = [...found.keys()].map((n) => `#${n}`).join(', ') || 'none'
        return say(`cannot tell PR #${pr}'s ticket: tickets with executor comments mentioned in `
          + `it: ${listed}; pass ticket N, or no_ticket for a PR without one`)
      }
      ;[number, status] = [...found.entries()][0]
    } else {
      status = executorStatus({ repo, issue: number, cwd, config })
      if (!status) {
        return say(`#${number} has no executor comment; pass the PR's ticket, or no_ticket for a `
          + 'PR without one')
      }
    }
    say(`#${number} latest executor status (${status.url}):\n${status.block}`)
    if (!status.ready) {
      return say(`#${number}'s executor is not waiting on ${config.stations.orchestrator} to `
        + 'merge; read its latest comment and wait until it asks for the merge. Nothing merged')
    }
  }
  github.write(
    ['pr', 'merge', String(pr), '--repo', repo, '--merge', '--match-head-commit', pull.headRefOid],
    { cwd },
  )
  pull = view()
  if (pull.state !== 'MERGED') {
    return say(`the merge command succeeded, but PR #${pr} is ${pull.state}; find out why`)
  }
  return { merged: pull.mergeCommit?.oid ?? null }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
