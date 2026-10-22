/**
 * Where the setup skill lives, and getting it there.
 *
 * The harness scans five skill roots. Only one of them is per machine rather than per
 * repository: `<DSH_HOME>/skills`, rank 400 (`user-dsh`). A skill placed there appears as
 * `/setup-dkitchen` in every project on the machine, which is what a setup skill should do —
 * copying it into each repository, one `ding skill install` per checkout, was the CLI's shape
 * and it made every new project start with a command nobody enjoys running.
 *
 * So the plugin installs it once. The copy is versioned by the bundle's own version: an
 * upgrade replaces the files, and an unchanged version costs one directory read at startup.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as paths from './paths.js'

/** The skill's directory name, which is also its `/command` name. */
export const SKILL_NAME = 'setup-dkitchen'

/** The copy that ships inside this bundle. */
export function bundledSkill() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills', SKILL_NAME)
}

/** The machine-wide skill root the harness scans at rank 400. */
export function userSkillRoot() {
  return join(paths.dshHome(), 'skills')
}

/** Where this bundle's copy of the skill is installed. */
export function installedSkill() {
  return join(userSkillRoot(), SKILL_NAME)
}

/** A marker recording which bundle version wrote the installed copy. */
function markerPath() {
  return join(installedSkill(), '.installed-from')
}

/**
 * The version this bundle declares.
 *
 * `lib/skill.js` sits one level below the package root, so the manifest is two levels up from
 * this file — not from the skill directory, which is what an earlier version of this comment
 * got wrong and read a path outside the package.
 */
export function bundleVersion() {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return String(manifest.version ?? '0')
  } catch {
    return '0'
  }
}


/**
 * Copy a directory tree one file at a time, skipping build artifacts.
 *
 * `cpSync` with `recursive` fails on some Windows filesystems with `EIO, Access is denied` even
 * when the destination exists, because it clones rather than reads and writes. This walks the
 * tree instead: a skill is a few small files, and a copy that always works is worth more than
 * one that is fast.
 *
 * `__pycache__` and `.pyc` are skipped. The skill ships Python helper scripts, and a checkout
 * that has run them leaves compiled files behind; copying those would put another machine's
 * bytecode into a skill directory that is otherwise readable source.
 */
function copyTree(source, target) {
  const info = statSync(source)
  if (info.isFile()) {
    if (source.endsWith('.pyc')) return
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    return
  }
  if (basename(source) === '__pycache__') return
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source)) {
    copyTree(join(source, entry), join(target, entry))
  }
}

/**
 * Install the skill when it is missing or stale.
 *
 * Returns `{installed, reason}`. A failure is reported rather than thrown: a skill that cannot
 * be copied must not stop the tools from registering, and the caller turns it into a note.
 */
export function ensureSkill({ force = false, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}
  const source = bundledSkill()
  if (!existsSync(join(source, 'SKILL.md'))) {
    return { installed: false, reason: `this bundle ships no ${SKILL_NAME} skill at ${source}` }
  }
  const target = installedSkill()
  const version = bundleVersion()
  let previous = null
  try {
    previous = readFileSync(markerPath(), 'utf8').trim()
  } catch {
    previous = null
  }
  if (!force && previous === version && existsSync(join(target, 'SKILL.md'))) {
    log('skill already at', target, 'for version', version)
    return { installed: false, reason: 'already current', path: target, version }
  }
  try {
    rmSync(target, { recursive: true, force: true })
    // A recursive `cpSync` into a directory under the OS temp root fails here with
    // `EIO, Access is denied` naming the destination, before and after the directory exists —
    // the copy uses a reflink/clone path those filesystems refuse. Copying file by file is
    // slower and always works, and a skill is a handful of small files.
    copyTree(source, target)
    // The templates travel with the skill, not only with the bundle: the installed copy is what
    // runs, and it resolves `../../kitchen` beside itself. Without this it would find no
    // templates and refuse to render, so the copy is made self-contained.
    const kitchen = join(dirname(source), '..', 'kitchen')
    if (existsSync(kitchen)) {
      copyTree(kitchen, join(userSkillRoot(), 'kitchen'))
    }
    writeFileSync(markerPath(), `${version}\n`, 'utf8')
    log('installed the skill at', target, 'for version', version)
    return { installed: true, path: target, version, replaced: previous }
  } catch (error) {
    return { installed: false, reason: `cannot install the skill at ${target}: ${error.message}` }
  }
}

/** Remove the installed copy, for a clean uninstall. */
export function removeSkill() {
  try {
    rmSync(installedSkill(), { recursive: true, force: true })
    return { removed: true, path: installedSkill() }
  } catch (error) {
    return { removed: false, reason: error.message }
  }
}
