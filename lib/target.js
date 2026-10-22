/**
 * What a target names: a session id, a session name, a ticket, or an issue URL.
 *
 * A kitchen's commands address a session the way a person would — its id, the name it was
 * given, `#42`, `OWNER/REPO#42`, or a pasted issue URL — so this module turns each of those
 * into one session id and refuses the ambiguous ones loudly. Guessing between two candidates
 * is how a message reaches the wrong station.
 */

import { execFileSync } from 'node:child_process'

import * as registry from './registry.js'

export const ISSUE_REPOSITORY = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'

const SESSION_ID = /^(session-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const ISSUE_URL = new RegExp(
  `^https://github\\.com/(${ISSUE_REPOSITORY})/(?:issues|pull)/([1-9][0-9]*)/?(?:\\?[^#\\s]*)?(?:#[^\\r\\n]*)?$`,
)
const ISSUE_TARGET = new RegExp(`^(${ISSUE_REPOSITORY})#([1-9][0-9]*)$`)

function ghJson(args, cwd) {
  let out
  try {
    out = execFileSync('gh', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error('the gh CLI is not installed; install it to use tickets')
    }
    throw new Error(`gh failed: ${(error.stderr || error.message || '').toString().trim()}`)
  }
  return JSON.parse(out)
}

/** The repository `gh` sees, for a bare `#42`. */
export function githubRepository(cwd) {
  const result = ghJson(['repo', 'view', '--json', 'nameWithOwner'], cwd)
  const repo = result && result.nameWithOwner
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('Malformed gh repository name.')
  }
  return repo
}

/** Expand a bare `#42` to `OWNER/REPO#42`, and an issue URL to the same shape. */
export function normalizeTarget(target, issue, config) {
  let value = target ?? null
  if (issue !== undefined && issue !== null) value = `#${issue}`
  if (value && value.startsWith('#')) {
    if (!/^#[1-9][0-9]*$/.test(value)) {
      throw new Error('Issue target must be # followed by a positive issue number.')
    }
    try {
      const repo = config ? config.repository() : githubRepository(config?.root)
      value = `${repo}${value}`
    } catch (error) {
      throw new Error(
        `'${value}' needs a GitHub repository in the current directory; elsewhere use `
        + `OWNER/REPO${value} or the issue URL. (${String(error.message).split(/\s+/).join(' ')})`,
      )
    }
  }
  if (value && (value.includes('://') || value.startsWith('http:'))) {
    const match = ISSUE_URL.exec(value)
    if (!match) {
      throw new Error('Issue URL must be https://github.com/OWNER/REPO/issues/NUMBER or /pull/NUMBER.')
    }
    value = `${match[1]}#${match[2]}`
  }
  if (value && /[^\s/]*\//.test(value) && value.includes('#')) {
    const match = ISSUE_TARGET.exec(value)
    if (!match || match[1].split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Issue target must be OWNER/REPO# followed by a positive issue number.')
    }
  }
  return value
}

/** Every `<label>: <session id>` value in a body. */
export function sessionReferences(body, label) {
  if (body === null || body === undefined) return []
  if (typeof body !== 'string') throw new Error('Malformed gh issue body.')
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(label)}:[ \\t]*([^\\r\\n]*)$`, 'gm')
  const found = []
  const text = body.replace(/\r\n/g, '\n')
  let match
  while ((match = pattern.exec(text)) !== null) {
    found.push(match[1].trim().replace(/^`+|`+$/g, ''))
  }
  return found
}

/** Owner or signature lines under any accepted spelling, old vocabulary included. */
export function allReferences(body, config, { owner }) {
  const patterns = owner ? config.ownerPatterns() : config.sessionPatterns()
  return patterns.flatMap((pattern) => sessionReferences(body, pattern))
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The session a ticket belongs to: dkitchen's own record first, then the ticket's owner line.
 *
 * The owner line wins over a signature line because it is the claim; a comment signed by a
 * session that does not own the ticket is evidence, not ownership.
 */
export function issueSession(number, repo, config) {
  const repository = repo ?? githubRepository(config?.root)
  const known = registry.findByIssue(repository, number)
  if (known.length === 1) return known[0].id

  const dir = config?.root
  const issue = ghJson(['api', `repos/${repository}/issues/${number}`], dir)
  if (!issue || typeof issue !== 'object') throw new Error('Malformed gh issue.')
  const comments = ghRecords(`repos/${repository}/issues/${number}/comments?per_page=100`, dir)

  const owners = []
  const candidates = []
  for (const record of [issue, ...comments]) {
    const found = allReferences(record.body, config, { owner: true })
    if (found.length) owners.push(...found)
    candidates.push(...allReferences(record.body, config, { owner: false }))
  }
  if (owners.length) return owners.at(-1)
  const unique = [...new Set(candidates)].sort()
  if (unique.length === 1) return unique[0]
  if (unique.length === 0) {
    throw new Error(`No session line in issue #${number}. Candidates: none.`)
  }
  const listing = unique.map((value) => `  ${value}`).join('\n')
  throw new Error(
    `Issue #${number} references ${unique.length} different sessions without an owner line. `
    + `Candidates:\n${listing}\nSpecify a session id or exact name instead.`,
  )
}

function ghRecords(resource, cwd) {
  const pages = ghJson(['api', '--paginate', '--slurp', resource], cwd)
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('Malformed gh pagination result.')
  }
  const records = pages.flat()
  if (records.some((record) => !record || typeof record !== 'object')) {
    throw new Error('Malformed gh record.')
  }
  return records
}

/**
 * The session id a target names.
 *
 * `knownSessions` is how the caller exposes the live sessions it can see: this runtime holds
 * them in memory, so the caller passes them in rather than being read from disk here.
 */
export function resolveTarget(target, issue, config, { knownSessions = () => [] } = {}) {
  const normalized = normalizeTarget(target, issue, config)
  if (!normalized) throw new Error('Name a session, a ticket, or an issue URL')

  if (SESSION_ID.test(normalized)) {
    return normalized.startsWith('session-') ? normalized : `session-${normalized}`
  }

  const issueMatch = ISSUE_TARGET.exec(normalized)
  if (issueMatch) return issueSession(Number(issueMatch[2]), issueMatch[1], config)

  const records = registry.load()
  let matches = [...records.values()]
    .filter((record) => displayCell(record.name) === normalized)
    .map((record) => record.id)
  // A station's name is reused when its session is replaced — the rules say so and the table
  // in roles.md is edited to match. The row for the retired session stays in the table, so a
  // bare name would otherwise name two sessions forever. The live one is the station now.
  if (matches.length > 1) {
    const live = new Set(knownSessions().map((session) => session.id))
    const current = matches.filter((id) => live.has(id))
    if (current.length) matches = current
  }
  if (matches.length === 1) return matches[0]

  const candidates = matches.length
    ? matches
    : [...records.keys()].length
      ? [...records.keys()]
      : knownSessions().map((session) => session.id)
  const listing = candidates.length ? candidates.map((value) => `  ${value}`).join('\n') : '  none'
  // Single quotes around the name, so a target that contains spaces reads as one value in the
  // refusal rather than as several words.
  throw new Error(`Found ${matches.length} sessions named ${repr(normalized)}. Candidates:\n${listing}`)
}

/** A string in single quotes, for messages that name a value. */
export function repr(text) {
  const body = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `'${body}'`
}

/** JSON-string escaping, so a name compared here matches the one a log line carries. */
export function displayCell(text) {
  return JSON.stringify(String(text)).slice(1, -1)
}

/** The first paragraph of a reply. */
export function replyHead(text) {
  return String(text).replace(/\r\n/g, '\n').split(/\n[ \t]*\n/, 1)[0].trim()
}
