/**
 * dkitchen's own record of the sessions it created.
 *
 * The harness knows a session's id, its working directory, and its event log, but nothing
 * about which station opened it or which ticket it serves. This table adds exactly that, one
 * JSON document under the state root, and its schema matches `src/dkitchen/registry.py` byte
 * for byte so both runtimes read the same rows.
 *
 * A session the user opened in the harness GUI has no row here. Every reader therefore falls
 * back to what the session itself says rather than assuming a row exists.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import * as paths from './paths.js'

export function path() {
  return paths.state('sessions.json')
}

/** Read the table, dropping rows that do not parse rather than failing the whole read. */
export function load() {
  const target = path()
  if (!existsSync(target)) return new Map()
  let raw
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    return new Map()
  }
  const sessions = raw && typeof raw === 'object' ? raw.sessions : null
  if (!sessions || typeof sessions !== 'object') return new Map()
  const records = new Map()
  for (const [id, value] of Object.entries(sessions)) {
    if (!value || typeof value !== 'object') continue
    records.set(id, {
      id,
      name: String(value.name || id),
      station: String(value.station || 'executor'),
      cwd: String(value.cwd || ''),
      created_ns: Number(value.created_ns || 0),
      issue: Number.isInteger(value.issue) ? value.issue : null,
      repo: typeof value.repo === 'string' ? value.repo : null,
      provider: typeof value.provider === 'string' ? value.provider : null,
      model: typeof value.model === 'string' ? value.model : null,
      effort: typeof value.effort === 'string' ? value.effort : null,
      closed: Boolean(value.closed),
    })
  }
  return records
}

/**
 * Write the table through a temporary file and an atomic rename.
 *
 * A half-written `sessions.json` would lose every row, so the visible file is only ever
 * replaced whole: `renameSync` is atomic on Windows and POSIX alike.
 */
export function save(records) {
  const target = path()
  const temporary = `${target}.tmp`
  mkdirp(dirname(target))
  const payload = {
    version: 1,
    sessions: Object.fromEntries(records),
  }
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

/** Insert or replace one row, preserving the ticket when the new row omits it. */
export function put(record) {
  const records = load()
  const previous = records.get(record.id)
  if (previous && !record.issue && previous.issue) {
    record = { ...record, issue: previous.issue, repo: previous.repo }
  }
  records.set(record.id, record)
  save(records)
  return record
}

export function get(sessionId) {
  return load().get(sessionId) ?? null
}

export function rename(sessionId, name) {
  const records = load()
  const record = records.get(sessionId)
  if (!record) return null
  const updated = { ...record, name }
  records.set(sessionId, updated)
  save(records)
  return updated
}

export function markClosed(sessionId) {
  const records = load()
  const record = records.get(sessionId)
  if (!record || record.closed) return
  records.set(sessionId, { ...record, closed: true })
  save(records)
}

export function findByIssue(repo, issue) {
  return [...load().values()].filter(
    (record) => record.issue === issue && (record.repo === null || record.repo === repo),
  )
}

function mkdirp(path) {
  mkdirSync(path, { recursive: true })
}
