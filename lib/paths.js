/**
 * Where dkitchen keeps its state.
 *
 * One directory holds everything the kitchen writes, and every reader goes through this
 * module. A second place to look would split the kitchen's memory in two, so nothing else
 * composes a state path by hand.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const WINDOWS = process.platform === 'win32'

/** The directory holding every file dkitchen writes. */
export function stateRoot() {
  const explicit = process.env.DKITCHEN_STATE_HOME
  if (explicit) return resolve(explicit)
  const xdg = process.env.XDG_STATE_HOME
  if (xdg) return join(resolve(xdg), 'ding')
  if (WINDOWS) {
    const local = process.env.LOCALAPPDATA
    if (local) return join(resolve(local), 'dkitchen')
  }
  return join(homedir(), '.local', 'state', 'ding')
}

export function state(...parts) {
  return join(stateRoot(), ...parts)
}

/** The DeepSeek Harness home; dkitchen reads it and never writes it. */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  if (explicit) return resolve(explicit)
  return join(homedir(), '.dsh')
}

/** Where DeepSeek Harness persists session logs. */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

export function profileDir(profile) {
  return join(dshHome(), 'profiles', profile)
}
