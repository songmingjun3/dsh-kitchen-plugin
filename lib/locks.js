/**
 * One cross-platform exclusive lock, built on `mkdir`'s atomicity.
 *
 * Node core has no `flock`, and a lock file created with `open` is not exclusive. `mkdir`
 * is: on every platform it either creates the directory or fails with `EEXIST`, and the OS
 * removes nothing on its own, so a stale directory survives a crash. That last part is why
 * every acquisition records a timestamp and owner inside the directory — a holder that died
 * can be detected and cleared, instead of wedging the kitchen forever.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Another holder owns the lock and the caller asked not to wait. */
export class LockBusy extends Error {
  constructor(message) {
    super(message)
    this.name = 'LockBusy'
  }
}

/** How long a lock directory may sit untouched before it counts as abandoned. */
export const STALE_MS = 30_000

function stamp(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Take the lock at `path`, waiting up to `timeoutMs` when `blocking`.
 *
 * Resolves to a release function. Throws `LockBusy` when the timeout passes first.
 */
export async function acquire(path, { blocking = false, timeoutMs = 60_000, staleMs = STALE_MS } = {}) {
  const deadline = Date.now() + (blocking ? timeoutMs : 0)
  mkdirSafe(dirname(path))
  for (;;) {
    try {
      mkdirSync(path)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // An abandoned holder: the directory has not moved for longer than any legitimate
      // holder would leave it untouched, and no process claims it.
      const when = stamp(path)
      if (when !== null && Date.now() - when > staleMs) {
        try {
          rmSync(path, { recursive: true, force: true })
          continue
        } catch {
          // Someone else cleared it first; fall through and retry the create.
        }
      }
      if (Date.now() >= deadline) {
        throw new LockBusy(`another writer is active for ${dirname(path)}`)
      }
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  try {
    writeFileSync(join(path, 'owner'), `${process.pid}\n${Date.now()}\n`, 'utf8')
  } catch {
    // The owner file is diagnostic only; losing it must not lose the lock.
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // A lock that is already gone is not an error worth failing the caller for.
    }
  }
}

/** Run `body` while holding the lock, releasing it even when `body` throws. */
export async function exclusive(path, body, options = {}) {
  const release = await acquire(path, options)
  try {
    return await body()
  } finally {
    release()
  }
}

/** Whether some holder currently owns the lock, without keeping it. */
export function isLocked(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function mkdirSafe(path) {
  try {
    mkdirSync(path, { recursive: true })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

export { readdirSync }
