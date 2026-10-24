/**
 * `.dkitchen.toml`: the vocabulary, stations, routes, and GitHub settings one repository uses.
 *
 * The reader is strict on purpose. Every refusal names the file and the key, because the
 * alternative — silently falling back to a default — is how a kitchen ends up running a
 * station nobody configured. `tests/config.test.mjs` holds each refusal, including the ones
 * that only look like typos.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parseToml, TomlError } from './toml.js'

export const FILE = '.dkitchen.toml'

/** The status block that opens an executor comment, in order: state, then who it waits on. */
export const DEFAULT_STATUS_FIELDS = ['Status', 'Waiting on', 'Key numbers', 'Next']

/** The stations a kitchen may run, in the order rules and reports mention them. */
export const STATIONS = ['orchestrator', 'designer', 'verifier', 'executor']

/** Signature lines older than the harness migration; they still resolve a ticket. */
export const LEGACY_SESSION_LINES = ['Codex session']
export const LEGACY_OWNER_LINES = ['Codex owner']

const SESSION_FIELDS = ['issue', 'name', 'repo']

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function fail(message) {
  throw new ConfigError(`${FILE}: ${message}`)
}

const DEFAULTS = {
  stations: {
    orchestrator: 'Orchestrator',
    designer: 'Designer',
    verifier: 'Verifier',
    executor: 'Executor',
    user: 'User',
    separator: ': ',
  },
  status: {
    fields: DEFAULT_STATUS_FIELDS,
    in_progress: 'in progress',
    waiting_on_design: 'waiting on design',
    blocked: 'blocked',
    done: 'done',
    none: 'none',
  },
  labels: { prefix: 'status:', awaiting_user: 'status:awaiting-user' },
  log: { issue: null, pending: 'Waiting for the user' },
  sessions: { name: '【#{issue}】{name}', owner_line: 'DSH owner', session_line: 'DSH session' },
  harness: {
    profile: 'dkitchen',
    default_provider: 'deepseek-official',
    default_model: 'deepseek-v4-flash',
    approvals: 'auto',
    permission: 'workspace-write',
  },
}

/** The keys each plain table accepts. */
const TABLE_KEYS = {
  stations: ['orchestrator', 'designer', 'verifier', 'executor', 'user', 'separator'],
  status: ['fields', 'in_progress', 'waiting_on_design', 'blocked', 'done', 'none'],
  labels: ['prefix', 'awaiting_user'],
  log: ['issue', 'pending'],
  sessions: ['name', 'owner_line', 'session_line'],
  harness: ['profile', 'default_provider', 'default_model', 'approvals', 'permission'],
}

/**
 * Tables this runtime defines beyond the vocabulary.
 *
 * `[approval]` names the tools a rule may answer without asking the user. `[permissions]`
 * names the permission preset each station opens under. Both are declared separately from
 * the shared tables so that adding one stays a visible decision rather than a key that slips
 * in with the rest.
 */
const EXTRA_TABLES = { approval: ['allow', 'reject'] }

/** `[permissions]`: a station → preset map, validated against the live catalog at creation. */
function permissionsSection(values) {
  if (!isPlainObject(values)) fail('[permissions] must be a table of station names to presets')
  const unknown = Object.keys(values).filter((key) => !STATIONS.includes(key)).sort()
  if (unknown.length) {
    fail(`[permissions] unknown stations: ${unknown.join(', ')}; use any of ${STATIONS.join(', ')}`)
  }
  const presets = {}
  for (const [station, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`[permissions] ${station} must be a preset name`)
    }
    presets[station] = value.trim()
  }
  return { presets }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A session name template using only `{issue}`, `{name}`, `{repo}`. */
function sessionTemplate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('[sessions] name must be a nonempty string')
  }
  const allowed = SESSION_FIELDS.map((field) => `{${field}}`).join(', ')
  const pattern = /\{([^}]*)\}/g
  let match
  while ((match = pattern.exec(value)) !== null) {
    const field = match[1]
    if (!SESSION_FIELDS.includes(field)) {
      fail(`[sessions] name uses {${field}}; use only ${allowed}`)
    }
  }
  // A lone closing brace would render as literal text; refuse it so a template cannot produce a
  // name with a stray brace in it.
  if (/\}(?!\{)/.test(value.replace(/\{[^}]*\}/g, ''))) {
    fail('[sessions] name contains an unmatched }')
  }
  return value
}

/** Walk a plain table, validating each key against the list above. */
function section(name, values) {
  if (!isPlainObject(values)) fail(`[${name}] must be a table`)
  const known = TABLE_KEYS[name]
  const unknown = Object.keys(values).filter((key) => !known.includes(key)).sort()
  if (unknown.length) fail(`unknown keys in [${name}]: ${unknown.join(', ')}`)
  const result = { ...DEFAULTS[name] }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'fields') {
      if (!Array.isArray(value) || value.length === 0
          || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
        fail(`[${name}] fields must be a nonempty list of field names`)
      }
      result.fields = value.map((item) => item.trim())
    } else if (key === 'name' && name === 'sessions') {
      result.name = sessionTemplate(value)
    } else if (key === 'issue') {
      if (!Number.isInteger(value) || typeof value === 'boolean' || value <= 0) {
        fail(`[${name}] issue must be a positive issue number`)
      }
      result.issue = value
    } else if (typeof value !== 'string' || (value.trim() === '' && key !== 'separator')) {
      fail(`[${name}] ${key} must be a nonempty string`)
    } else {
      result[key] = value
    }
  }
  return result
}

function kitchenSection(values) {
  if (!isPlainObject(values)) fail('[kitchen] must be a table')
  const unknown = Object.keys(values).filter((key) => key !== 'stations').sort()
  if (unknown.length) fail(`unknown keys in [kitchen]: ${unknown.join(', ')}`)
  const stations = values.stations
  if (stations === undefined) return { stations: [...STATIONS] }
  if (!Array.isArray(stations) || stations.length === 0
      || !stations.every((item) => typeof item === 'string')) {
    fail('[kitchen] stations must be a nonempty list of station names')
  }
  const bad = stations.filter((item) => !STATIONS.includes(item)).sort()
  if (bad.length) fail(`[kitchen] unknown stations: ${bad.join(', ')}; use any of ${STATIONS.join(', ')}`)
  if (new Set(stations).size !== stations.length) fail('[kitchen] stations names a station twice')
  return { stations: STATIONS.filter((item) => stations.includes(item)) }
}

function harnessSection(values) {
  const result = section('harness', values)
  if (!['auto', 'ask'].includes(result.approvals)) {
    fail("[harness] approvals must be 'auto' or 'ask'")
  }
  return result
}

function modelsSection(values) {
  if (!isPlainObject(values)) fail('[models] must be a table of per-station tables')
  const unknown = Object.keys(values).filter((key) => !STATIONS.includes(key)).sort()
  if (unknown.length) {
    fail(`[models] unknown stations: ${unknown.join(', ')}; use any of ${STATIONS.join(', ')}`)
  }
  const stations = {}
  for (const [station, table] of Object.entries(values)) {
    if (!isPlainObject(table)) fail(`[models.${station}] must be a table`)
    const allowed = ['provider', 'model', 'effort']
    const extra = Object.keys(table).filter((key) => !allowed.includes(key)).sort()
    if (extra.length) fail(`unknown keys in [models.${station}]: ${extra.join(', ')}`)
    const route = {}
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string' || value.trim() === '') {
        fail(`[models.${station}] ${key} must be a nonempty string`)
      }
      route[key] = value
    }
    stations[station] = route
  }
  return { stations }
}

/**
 * Read a table this runtime alone defines.
 *
 * Each key is a list of tool names; anything else is refused, because a mistyped policy that
 * silently did nothing would leave an unattended kitchen unable to run what it was configured
 * for, with no clue why.
 */
function extraSection(name, values) {
  if (!isPlainObject(values)) fail(`[${name}] must be a table`)
  const known = EXTRA_TABLES[name]
  const unknown = Object.keys(values).filter((key) => !known.includes(key)).sort()
  if (unknown.length) fail(`unknown keys in [${name}]: ${unknown.join(', ')}`)
  const result = {}
  for (const [key, value] of Object.entries(values)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
      fail(`[${name}] ${key} must be a list of tool names`)
    }
    result[key] = value.map((item) => item.trim())
  }
  return result
}

/** The Git work tree holding `cwd`, or `cwd` itself outside Git. */
export function repositoryRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out ? resolve(out) : resolve(cwd)
  } catch {
    return resolve(cwd)
  }
}

/**
 * Load the configuration for a repository.
 *
 * `root` may be given explicitly; otherwise the Git work tree holding `cwd` is used, which is
 * what every command means by "this repository".
 */
export function load(cwd = process.cwd(), options = {}) {
  const root = options.root ?? repositoryRoot(cwd)
  const path = join(root, FILE)
  if (!existsSync(path)) {
    return build(root, {})
  }
  const text = readFileSync(path, 'utf8')
  // A UTF-8 BOM is refused rather than silently skipped: TOML does not allow one, and a file
  // that other TOML readers reject must not work here, or a repo configured with this bundle
  // would break the first time anything else opened it.
  if (text.charCodeAt(0) === 0xfeff) {
    throw new ConfigError(`${path}: line 1: a byte-order mark is not valid TOML; save the file as UTF-8 without one`)
  }
  let data
  try {
    data = parseToml(text)
  } catch (error) {
    if (error instanceof TomlError) throw new ConfigError(`${path}: ${error.message.replace(/^\.dkitchen\.toml:/, 'line ')}`)
    throw error
  }
  return build(root, data)
}

function build(root, data) {
  const sections = ['stations', 'status', 'labels', 'log', 'sessions']
  const special = ['kitchen', 'harness', 'models', 'permissions', ...Object.keys(EXTRA_TABLES)]
  const unknown = Object.keys(data)
    .filter((key) => key !== 'repo' && !sections.includes(key) && !special.includes(key))
    .sort()
  if (unknown.length) fail(`unknown keys: ${unknown.join(', ')}`)

  let repo = null
  if (data.repo !== undefined) {
    if (typeof data.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(data.repo)) {
      fail('repo must look like owner/name')
    }
    repo = data.repo
  }

  const loaded = {}
  for (const name of sections) {
    if (data[name] !== undefined) loaded[name] = section(name, data[name])
  }
  if (data.kitchen !== undefined) loaded.kitchen = kitchenSection(data.kitchen)
  if (data.harness !== undefined) loaded.harness = harnessSection(data.harness)
  if (data.models !== undefined) loaded.models = modelsSection(data.models)
  if (data.permissions !== undefined) loaded.permissions = permissionsSection(data.permissions)
  for (const name of Object.keys(EXTRA_TABLES)) {
    if (data[name] !== undefined) loaded[name] = extraSection(name, data[name])
  }

  const config = { root, repo, ...loaded }
  // Which sections the file actually wrote, as opposed to which `withHelpers` filled in. A
  // consumer that wants to know whether the repository *chose* a route cannot tell from the
  // resolved object alone: `harness` always carries a provider and a model once the defaults
  // are applied. Recording it here keeps that distinction available without a second read.
  config.declared = {
    harness: data.harness !== undefined,
    models: data.models !== undefined,
  }
  return withHelpers(config)
}

/** Attach the derived readers, so callers never recompute a route or a name by hand. */
function withHelpers(config) {
  config.kitchen ??= { stations: [...STATIONS] }
  config.stations ??= { ...DEFAULTS.stations }
  config.harness ??= { ...DEFAULTS.harness }
  config.models ??= { stations: {} }
  config.status ??= { ...DEFAULTS.status }
  config.labels ??= { ...DEFAULTS.labels }
  config.log ??= { ...DEFAULTS.log }
  config.sessions ??= { ...DEFAULTS.sessions }
  config.approval ??= { allow: [], reject: [] }
  config.permissions ??= { presets: {} }

  /** The permission preset a station's sessions open under, or null for the harness default. */
  config.permissionFor = (station) => config.permissions.presets[station] ?? null

  config.route = (station) => {
    const own = config.models.stations[station] ?? {}
    return {
      provider: own.provider ?? config.harness.default_provider,
      model: own.model ?? config.harness.default_model,
      effort: own.effort ?? null,
    }
  }
  config.includes = (station) => config.kitchen.stations.includes(station)
  config.signature = (name) => `${name}${config.stations.separator}`
  config.sessionName = ({ issue, name, repo }) => config.sessions.name
    .replaceAll('{issue}', String(issue))
    .replaceAll('{name}', name)
    .replaceAll('{repo}', repo ?? '')
  config.ownerPatterns = () => [config.sessions.owner_line, ...LEGACY_OWNER_LINES]
  config.sessionPatterns = () => [config.sessions.session_line, ...LEGACY_SESSION_LINES]

  /** The repository: configured, else what `gh` sees from the repository root. */
  config.repository = () => {
    if (config.repo) return config.repo
    let out
    try {
      out = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
        cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new ConfigError(`the gh CLI is not installed; install it, or set repo in ${FILE}`)
      }
      throw new ConfigError(`cannot tell the GitHub repository; set repo in ${FILE}: ${(error.stderr || '').toString().trim()}`)
    }
    if (!out) throw new ConfigError(`cannot tell the GitHub repository; set repo in ${FILE}`)
    return out
  }
  return config
}
