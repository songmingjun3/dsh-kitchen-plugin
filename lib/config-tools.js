/**
 * The configuration and verification tools: `config`, `check-refs`.
 *
 * `config` shows what the kitchen resolved and can change one dotted key. It writes
 * `.dkitchen.toml` as a surgical edit that keeps every other line, because a rewritten file
 * loses the comments a person put there to explain the values.
 */

import { existsSync, readFileSync, writeFileSync as writeText } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { defineTool } from './registry-access.js'
import { FILE, STATIONS, load } from './config.js'
import { resolveRoot } from './cwd.js'
import * as refs from './refs.js'

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** A dotted key split into its table and its name. */
export function splitKey(key) {
  const text = String(key)
  if (!text.includes('.')) return { table: null, name: text }
  const parts = text.split('.')
  const name = parts.pop()
  return { table: parts.join('.'), name }
}

/**
 * Set one dotted key, keeping every other line of the file.
 *
 * A key inside a table is edited in that table; a missing table is appended. A top-level key
 * is edited above the first table header. Values are written as strings, which is what every
 * key in `.dkitchen.toml` except `stations`, `fields`, and `issue` accepts.
 */
export function writeSetting(text, key, value) {
  const { table, name } = splitKey(key)
  const lines = text.split(/\r?\n/)
  const rendered = renderScalar(value)

  let tableLine = -1
  for (let index = 0; index < lines.length; index++) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[index])
    if (header && header[1].trim() === table) tableLine = index
    else if (header && tableLine >= 0) break
  }

  if (table === null) {
    // A top-level key lives before any table header.
    const firstHeader = lines.findIndex((line) => /^\s*\[/.test(line))
    const stop = firstHeader < 0 ? lines.length : firstHeader
    for (let index = 0; index < stop; index++) {
      if (new RegExp(`^\\s*${escapeRegExp(name)}\\s*=`).test(lines[index])) {
        lines[index] = `${name} = ${rendered}`
        return lines.join('\n')
      }
    }
    const at = firstHeader < 0 ? lines.length : firstHeader
    lines.splice(at, 0, `${name} = ${rendered}`)
    return lines.join('\n')
  }

  if (tableLine >= 0) {
    const stop = (() => {
      for (let index = tableLine + 1; index < lines.length; index++) {
        if (/^\s*\[/.test(lines[index])) return index
      }
      return lines.length
    })()
    for (let index = tableLine + 1; index < stop; index++) {
      if (new RegExp(`^\\s*${escapeRegExp(name)}\\s*=`).test(lines[index])) {
        lines[index] = `${name} = ${rendered}`
        return lines.join('\n')
      }
    }
    lines.splice(stop, 0, `${name} = ${rendered}`)
    return lines.join('\n')
  }

  const tail = lines.at(-1) === '' ? lines.slice(0, -1) : lines
  tail.push('', `[${table}]`, `${name} = ${rendered}`)
  return `${tail.join('\n')}\n`
}

function renderScalar(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`
  if (typeof value === 'number') return String(value)
  const text = String(value)
  // A bare word reads better and is what the shipped examples use; anything else is quoted.
  if (/^[A-Za-z0-9_./-]+$/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) return JSON.stringify(text)
  return JSON.stringify(text)
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function registerConfigTools(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.tools.register(defineTool({
    name: 'dkitchen_config',
    description: "Show this repository's kitchen settings, or change one dotted key. "
      + 'Actions: show, set, models.',
    parameters: {
      action: { type: 'string', required: true, description: 'show, set, or models' },
      key: { type: 'string', description: "The dotted key to set, such as models.executor.model" },
      value: { type: 'string', description: 'The value to write' },
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const root = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent, ctx })

      if (args.action === 'show') {
        const config = resolveConfig(root.root)
        return {
          root: config.root,
          repo: config.repo,
          stations: config.kitchen.stations,
          routes: Object.fromEntries(
            config.kitchen.stations.map((station) => [station, config.route(station)]),
          ),
          harness: config.harness,
          status: config.status,
          log: config.log,
          sessions: config.sessions,
          approval: config.approval,
        }
      }

      if (args.action === 'models') {
        // The routes a profile actually offers are not readable from here; what a kitchen can
        // say is which route each station would use, and whether that is its own or the default.
        const config = resolveConfig(root.root)
        return {
          default: config.harness.default_provider
            ? `${config.harness.default_provider}/${config.harness.default_model}`
            : null,
          stations: Object.fromEntries(config.kitchen.stations.map((station) => {
            const own = config.models.stations[station] ?? {}
            return [station, {
              provider: config.route(station).provider,
              model: config.route(station).model,
              effort: config.route(station).effort,
              inherited: Object.keys(own).length === 0,
            }]
          })),
        }
      }

      if (args.action === 'set') {
        if (!args.key || args.value === undefined) {
          throw new Error('set needs both key and value')
        }
        const { name } = splitKey(args.key)
        if (args.key.startsWith('kitchen.stations')) {
          const names = String(args.value).split(',').map((item) => item.trim()).filter(Boolean)
          const bad = names.filter((item) => !STATIONS.includes(item))
          if (bad.length) {
            throw new Error(`unknown stations: ${bad.join(', ')}; use any of ${STATIONS.join(', ')}`)
          }
          writeFile(root.root, args.key, names)
        } else if (name === 'issue') {
          const number = Number(args.value)
          if (!Number.isInteger(number) || number <= 0) {
            throw new Error('[log] issue must be a positive issue number')
          }
          writeFile(root.root, args.key, number)
        } else if (name === 'fields') {
          writeFile(root.root, args.key, String(args.value).split(',').map((item) => item.trim()))
        } else {
          writeFile(root.root, args.key, String(args.value))
        }
        // Read it back, so a value the reader refuses is reported here and not at the next call.
        const config = load(root.root, { root: root.root })
        log('set', args.key)
        return { key: args.key, value: args.value, file: join(config.root, FILE) }
      }

      throw new Error(`unknown action ${JSON.stringify(args.action)}; use show, set, or models`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_check_refs',
    description: 'Check every `file:line` and `sha256` in a draft comment against the files it '
      + "cites. Reports what is wrong and what could not be checked, separately.",
    parameters: {
      draft: { type: 'string', required: true, description: 'Path to the draft comment file' },
      ref: { type: 'string', description: 'Git revision to read files from (default: the working tree)' },
      tolerance: { type: 'number', description: 'Lines of slack around a cited line (default: 0)' },
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const root = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent, ctx })
      const config = resolveConfig(root.root)
      // A relative path is relative to the repository the call is about, not to the harness
      // process: the model works in a session, and its directory is the one `resolveRoot`
      // found. Resolving against `process.cwd()` would read a file somewhere else, or none.
      const draftPath = isAbsolute(args.draft) ? args.draft : join(config.root, args.draft)
      let draft
      try {
        draft = readFileSync(draftPath, 'utf8')
      } catch (error) {
        throw new Error(`cannot read the draft at ${draftPath}: ${String(error.message)}`)
      }
      const source = args.ref
        ? new refs.Source(args.ref, null)
        : new refs.Source(null, config.root)
      const result = refs.check(draft, source, args.tolerance ?? 0)
      return {
        checked: result.checked,
        findings: result.findings,
        unchecked: result.notes,
        ok: result.findings.length === 0,
      }
    },
  }))
}

/** Apply one setting to the repository's `.dkitchen.toml`. */
function writeFile(root, key, value) {
  const path = join(root, FILE)
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeText(path, writeSetting(text, key, value), 'utf8')
}

export { writeFile }
