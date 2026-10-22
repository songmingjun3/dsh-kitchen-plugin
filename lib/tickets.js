/**
 * Reading a ticket the way the house rules describe it.
 *
 * A ticket's role, its status block, whether an executor waits on the orchestrator, and what
 * counts as stale are decisions the station rules depend on: changing them silently would move
 * real work between stations without anyone asking for it. So each rule here follows the text
 * in `kitchen/core/`, and a change to one belongs in both.
 *
 * These are pure functions over a comment body and the repository's configuration, so they can
 * be tested against samples without a network.
 */

/** The station named at the start of the first line, else the executor, else the user. */
export function role(body, config) {
  const stations = config.stations
  const firstLine = String(body ?? '')
    .split(/\r?\n/)
    .find((line) => line.trim() !== '') ?? ''
  const first = firstLine.replace(/^[\s#*>]+/, '')
  for (const name of [stations.designer, stations.verifier, stations.orchestrator]) {
    if (first.startsWith(name)) return name
  }
  for (const label of config.sessionPatterns()) {
    const pattern = new RegExp(`^[ \\t]*${escapeRegExp(label)}:`, 'm')
    if (pattern.test(String(body ?? ''))) return stations.executor
  }
  return stations.user
}

/** The status block's fields, accepting a half- or full-width colon. */
export function fields(body, config) {
  const names = config.status.fields
  const result = {}
  const lines = String(body ?? '').split(/\r?\n/).slice(0, names.length)
  for (const line of lines) {
    const parts = splitOnce(line)
    if (parts) result[parts[0].trim()] = parts[1].trim()
  }
  return result
}

function splitOnce(line) {
  const index = line.search(/[:：]/)
  if (index < 0) return null
  return [line.slice(0, index), line.slice(index + 1)]
}

/** The state and the "waiting on" value from a comment's status block. */
export function stateAndWaiting(body, config) {
  const block = fields(body, config)
  const names = config.status.fields
  const state = block[names[0]] ?? ''
  const waiting = names.length > 1 ? (block[names[1]] ?? '') : ''
  return [state, waiting]
}

/**
 * Whether an executor's comment should wake the orchestrator.
 *
 * On an awaiting-user ticket only a blocked, done, or design-waiting executor wakes it, or one
 * naming a kitchen station; otherwise any state but "in progress" does, or naming the user.
 */
export function executorWakes(body, waitingUser, config) {
  const [state, waiting] = stateAndWaiting(body, config)
  const status = config.status
  const stations = config.stations
  const names = (...who) => !waiting.startsWith(status.none) && who.some((name) => waiting.includes(name))
  const kitchen = [stations.orchestrator, stations.designer, stations.verifier]
  if (waitingUser) {
    return [status.blocked, status.done, status.waiting_on_design].includes(state)
      || names(...kitchen)
  }
  return state !== status.in_progress || names(...kitchen, stations.user)
}

/** The status block's first two lines, or the first line when there is no block. */
export function summary(body, config) {
  const count = config.status.fields.length
  const names = config.status.fields.slice(0, 2)
  const lines = String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const picked = lines.slice(0, count).filter((line) => names.some((name) => line.startsWith(name)))
  const chosen = picked.length ? picked : lines.slice(0, 1)
  return chosen.join('; ').slice(0, 160)
}

/**
 * A comment carrying a station signature.
 *
 * Both the current and the pre-migration spellings count, so a ticket written before the
 * harness move still reads correctly.
 */
export function isSigned(body, config) {
  return config.sessionPatterns().some((label) => {
    const pattern = new RegExp(`^[ \\t]*${escapeRegExp(label)}:`, 'm')
    return pattern.test(String(body ?? ''))
  })
}

/** A comment opens with an executor's status block. */
export function hasStatusBlock(body, config) {
  const [state] = stateAndWaiting(body, config)
  return state !== ''
}

/**
 * Whether an executor's comment is stale: "in progress" and older than the cutoff.
 *
 * A comment with no status block is not stale — it is something else, and treating it as a
 * stuck executor would wake the orchestrator over a note.
 */
export function isStale(body, updatedAt, cutoffIso, config) {
  const [state] = stateAndWaiting(body, config)
  if (state !== config.status.in_progress) return false
  return String(updatedAt) < cutoffIso
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
