/**
 * GitHub access for the kitchen's ticket work.
 *
 * Every function here shells out to `gh`; nothing else in the plugin does. The rules are not
 * reimplemented here either: a ticket's role, its status block, whether an executor waits on
 * the orchestrator, and what counts as a stale ticket live in `tickets.js`, and this module
 * only fetches what those functions read. `gh` is optional — a kitchen without it loses the
 * ticket tools and keeps the rest, and each caller says so instead of failing obscurely.
 */

import { execFileSync } from 'node:child_process'

/** `gh` could not answer. The message is the one worth showing the user. */
export class GitHubError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Whether the `gh` CLI is installed at all. */
export function available() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

function run(args, { cwd, timeout = 60_000 } = {}) {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new GitHubError('the gh CLI is not installed; install it to use tickets')
    }
    const detail = (error.stderr || error.message || '').toString().trim()
    throw new GitHubError(detail || `gh ${args.join(' ')} failed`)
  }
}

/** Parse one `gh --json` reply. */
export function json(args, options) {
  const text = run(args, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new GitHubError('gh returned something that is not JSON')
  }
}

/**
 * Read a paginated `gh api` listing as one array of records.
 *
 * `--slurp` returns an array of pages; flattening here keeps every caller from having to
 * remember that the outer and inner shapes differ.
 */
export function records(resource, options) {
  const pages = json(['api', '--paginate', '--slurp', resource], options)
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new GitHubError('Malformed gh pagination result.')
  }
  const flat = pages.flat()
  if (flat.some((record) => !record || typeof record !== 'object')) {
    throw new GitHubError('Malformed gh record.')
  }
  return flat
}

/** Read an unpaginated record. */
export function record(resource, options) {
  const value = json(['api', resource], options)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubError('Malformed gh record.')
  }
  return value
}

/** The repository `gh` sees from `cwd`. */
export function repository(cwd) {
  const value = json(['repo', 'view', '--json', 'nameWithOwner'], { cwd })
  const repo = value && value.nameWithOwner
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new GitHubError('Malformed gh repository name.')
  }
  return repo
}

/** Post a comment and return its URL. */
export function comment({ repo, issue, body, cwd }) {
  const out = run(['issue', 'comment', String(issue), '--repo', repo, '--body', body], { cwd })
  return out.trim()
}

/** Run a mutating `gh` command and return its output, refusing when it fails. */
export function write(args, options) {
  return run(args, options)
}

/** The issue number an API URL names. */
export function issueNumber(url) {
  const parts = String(url).replace(/\/+$/, '').split('/')
  return Number(parts.at(-1))
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the shape `gh --since` expects. */
export function stamp(moment = new Date()) {
  return `${moment.toISOString().slice(0, 19)}Z`
}

/**
 * Pages of a newest-first listing until an item is older than `since`.
 *
 * GitHub returns one page at a time and has no "stop at this time" parameter for most
 * listings, so the boundary has to be found by reading until it is crossed.
 */
export function newer(resource, field, since, { pages = 3, cwd } = {}) {
  const items = []
  for (let page = 1; page <= pages; page++) {
    const batch = json(['api', `${resource}&per_page=100&page=${page}`], { cwd })
    if (!Array.isArray(batch)) throw new GitHubError('Malformed gh listing.')
    items.push(...batch.filter((item) => String(item[field]) >= since))
    if (batch.length < 100 || String(batch.at(-1)[field]) < since) break
  }
  return items
}
