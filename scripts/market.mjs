#!/usr/bin/env node
/**
 * The DeepSeek Harness plugin market index: generate it, and check it before publishing.
 *
 * The harness's Discover tab reads a JSON document the harness validates with
 * `@deepseek-ai/dsh-plugin-market-index`. That package is format 1, and its rules are strict:
 * `format` must be 1, the title must carry an `en` key, every plugin needs a name and at
 * least one version, and every version needs an exact SemVer, an integer publish timestamp,
 * and a source. An index that violates any rule is refused as a whole, so an editor typo
 * does not degrade the listing — it removes it.
 *
 * This module reproduces those rules rather than generating and hoping. The validator here is
 * deliberately a second implementation of the harness's: it lets the generator fail in CI,
 * where a broken index is cheap to fix, instead of after publishing, where the only symptom is
 * a Discover tab that reports a failed read.
 *
 * The version's `source` is `git`, not `npm`. `dsh-dkitchen` is `private` and not published to
 * a registry, and the bundle is plain JavaScript with no build step, so installing it from a
 * pinned commit of this repository works: the harness turns `{url, commit, path}` into
 * `git+<url>.git#<commit>&path:/<dir>`, which pnpm can clone and install directly.
 *
 * Usage:
 *   node scripts/market.mjs index            # write docs/market/index.json at HEAD
 *   node scripts/market.mjs index --check    # validate the committed one instead
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The index URL a user adds to Discover. Relative icon paths resolve against it, and it is the
 * document the repository publishes, so the value is part of the deliverable.
 *
 * A Discover entry installs a pinned `git+https://…#<commit>` clone, so an index whose URL or
 * commit does not match what was pushed would offer an install nobody can fetch.
 */
export const INDEX_URL =
  'https://raw.githubusercontent.com/songmingjun3/dsh-kitchen-plugin/main/docs/market/index.json'

/**
 * Where the bundle sits inside this repository, which is what a git source installs.
 *
 * This repository *is* the bundle: `package.json`, `index.js`, and `lib/` are at the root. A
 * git source names that with an **absent** `path`, not with `'.'` — the harness rejects a `.`
 * segment — and `marketInstallTarget` then yields `git+<url>.git#<commit>` with no `&path:/`.
 */
export const BUNDLE_PATH = null

export const REPOSITORY_URL = 'https://github.com/songmingjun3/dsh-kitchen-plugin'

/** The dsh range the bundle declares, restated so the index cannot drift from the manifest. */
export const DSH_RANGE = '>=0.2.0-rc.1 <0.3.0'

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const COMMIT = /^[0-9a-f]{40}$/
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}`
  + `(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?`
  + `(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
)
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/
const PACKAGE_PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/

/** Largest decoded payload the harness accepts for an inline `data:` icon. */
export const MAX_INLINE_ICON_BYTES = 32 * 1024

/** The harness rejects any publish timestamp at or above this. */
export const MAX_PUBLISH_TIMESTAMP = 10 ** 11

/** A document that violates format 1, carrying the JSON path of the offending value. */
export class IndexError extends Error {
  constructor(path, reason) {
    super(`${path} ${reason}`)
    this.name = 'IndexError'
    this.path = path
    this.reason = reason
  }
}

function fail(path, reason) {
  throw new IndexError(path, reason)
}

function objectAt(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value
}

function stringAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a string with a non-whitespace character')
  }
  return value
}

/** A localized string: either a plain string, or a language map that must contain `en`. */
function localized(value, path) {
  if (typeof value === 'string') return { en: stringAt(value, path) }
  const mapping = objectAt(value, path)
  const text = {}
  for (const [language, member] of Object.entries(mapping)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id')
    text[language] = stringAt(member, `${path}.${language}`)
  }
  if (!('en' in text)) fail(path, 'must contain en')
  return text
}

function declaredId(value, path, declared) {
  const identifier = stringAt(value, path)
  if (!(identifier in declared)) fail(path, `references undeclared id '${identifier}'`)
  return identifier
}

function urlAt(value, path, schemes) {
  const text = stringAt(value, path)
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text)
  if (!match) fail(path, 'must be an absolute URL')
  if (!schemes.includes(`${match[1].toLowerCase()}:`)) fail(path, `must use ${schemes.join(', ')}`)
  const parts = text.split('/')
  if (parts.length >= 3 && parts[2].includes('@')) fail(path, 'must not contain credentials')
  return text
}

function packagePath(value, path) {
  const text = stringAt(value, path)
  for (const segment of text.split('/')) {
    if (segment === '.' || segment === '..' || !PACKAGE_PATH_SEGMENT.test(segment)) {
      fail(path, 'must be a relative directory without . or .. segments')
    }
  }
  return text
}

function repositoryAt(value, path) {
  const mapping = objectAt(value, path)
  const result = { url: urlAt(mapping.url, `${path}.url`, ['https:', 'http:']) }
  if (mapping.directory !== undefined && mapping.directory !== null) {
    result.directory = packagePath(mapping.directory, `${path}.directory`)
  }
  return result
}

function sourceAt(value, path) {
  const mapping = objectAt(value, path)
  const kind = mapping.type
  if (kind === 'npm') {
    const result = { type: 'npm' }
    if (mapping.registry !== undefined && mapping.registry !== null) {
      result.registry = urlAt(mapping.registry, `${path}.registry`, ['https:', 'http:'])
    }
    return result
  }
  if (kind === 'git') {
    const commit = stringAt(mapping.commit, `${path}.commit`)
    if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA')
    const result = { type: 'git', url: urlAt(mapping.url, `${path}.url`, ['https:']), commit }
    if (mapping.path !== undefined && mapping.path !== null) {
      result.path = packagePath(mapping.path, `${path}.path`)
    }
    return result
  }
  fail(`${path}.type`, 'must be "npm" or "git"')
}

function iconAt(value, path) {
  const text = stringAt(value, path)
  if (text.startsWith('data:')) {
    const match = DATA_ICON.exec(text)
    if (!match || !match[1]) fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL')
    const payload = match[1]
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    if ((payload.length / 4) * 3 - padding > MAX_INLINE_ICON_BYTES) {
      fail(path, `must not exceed ${MAX_INLINE_ICON_BYTES / 1024} KiB of decoded bytes`)
    }
    return text
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
    if (!text.toLowerCase().startsWith('https:')) fail(path, 'must resolve to https or the index origin')
    return text
  }
  // A relative reference: the harness resolves it against the index URL and accepts it only
  // when the result stays on that origin, so a plain file name beside the index is the shape
  // that works.
  if (text.startsWith('//') || text.startsWith('/')) fail(path, 'must be a relative file reference beside the index')
  return text
}

function versionsAt(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array')
  const seen = new Set()
  const versions = []
  value.forEach((entry, position) => {
    const at = `${path}[${position}]`
    const mapping = objectAt(entry, at)
    const version = stringAt(mapping.version, `${at}.version`)
    if (!SEMVER.test(version)) fail(`${at}.version`, 'must be an exact SemVer version')
    if (seen.has(version)) fail(`${at}.version`, `duplicates ${version}`)
    seen.add(version)
    const stamp = mapping.publishTimestamp
    if (!Number.isInteger(stamp) || stamp < 0 || stamp >= MAX_PUBLISH_TIMESTAMP) {
      fail(`${at}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)')
    }
    const parsed = { version, publishTimestamp: stamp, source: sourceAt(mapping.source, `${at}.source`) }
    parsed.engines = {}
    if (mapping.engines !== undefined && mapping.engines !== null) {
      const engines = objectAt(mapping.engines, `${at}.engines`)
      if (engines.dsh !== undefined && engines.dsh !== null) {
        const range = stringAt(engines.dsh, `${at}.engines.dsh`)
        if (range.startsWith('workspace:')) fail(`${at}.engines.dsh`, 'must not be a workspace: range')
        parsed.engines.dsh = range
      }
    }
    versions.push(parsed)
  })
  return versions
}

function pluginMetadata(value, path, categories, labels) {
  const mapping = objectAt(value, path)
  const result = { keywords: [], labels: [], sortKeys: {} }
  if (mapping.category !== undefined && mapping.category !== null) {
    result.category = declaredId(mapping.category, `${path}.category`, categories)
  }
  if (mapping.keywords !== undefined && mapping.keywords !== null) {
    if (!Array.isArray(mapping.keywords)) fail(`${path}.keywords`, 'must be an array')
    result.keywords = mapping.keywords.map((word, index) => stringAt(word, `${path}.keywords[${index}]`))
  }
  if (mapping.labels !== undefined && mapping.labels !== null) {
    if (!Array.isArray(mapping.labels)) fail(`${path}.labels`, 'must be an array')
    const ids = mapping.labels.map((label, index) => declaredId(label, `${path}.labels[${index}]`, labels))
    if (new Set(ids).size !== ids.length) fail(`${path}.labels`, 'must not repeat a label')
    result.labels = ids
  }
  return result
}

function pluginAt(value, path, categories, labels) {
  const mapping = objectAt(value, path)
  const name = stringAt(mapping.name, `${path}.name`)
  if (name.length > 214 || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name')
  const result = { name }
  for (const field of ['title', 'description']) {
    const member = mapping[field]
    if (member !== undefined && member !== null) result[field] = localized(member, `${path}.${field}`)
  }
  if (mapping.icon !== undefined && mapping.icon !== null) result.icon = iconAt(mapping.icon, `${path}.icon`)
  if (mapping.author !== undefined && mapping.author !== null) result.author = stringAt(mapping.author, `${path}.author`)
  if (mapping.homepage !== undefined && mapping.homepage !== null) {
    result.homepage = urlAt(mapping.homepage, `${path}.homepage`, ['https:', 'http:'])
  }
  if (mapping.repository !== undefined && mapping.repository !== null) {
    result.repository = repositoryAt(mapping.repository, `${path}.repository`)
  }
  result.metadata = pluginMetadata(mapping.metadata ?? {}, `${path}.metadata`, categories, labels)
  result.versions = versionsAt(mapping.versions, `${path}.versions`)
  return result
}

function declarationsAt(value, path, { sortKeys = false } = {}) {
  if (value === undefined || value === null) return {}
  const mapping = objectAt(value, path)
  const result = {}
  for (const [identifier, member] of Object.entries(mapping)) {
    if (identifier === '') fail(path, 'must not declare an empty id')
    const entry = objectAt(member, `${path}.${identifier}`)
    const record = { title: localized(entry.title, `${path}.${identifier}.title`) }
    if (sortKeys) {
      if (entry.order !== 'asc' && entry.order !== 'desc') {
        fail(`${path}.${identifier}.order`, 'must be "asc" or "desc"')
      }
      record.order = entry.order
    }
    result[identifier] = record
  }
  return result
}

/** Throw `IndexError` for the first rule the document violates. */
export function validateIndex(document, indexUrl = INDEX_URL) {
  if (!/^https?:\/\//.test(indexUrl)) fail('$', `index URL '${indexUrl}' must be an absolute URL`)
  const mapping = objectAt(document, '$')
  if (mapping.format !== 1) fail('$.format', 'must be 1')
  const metadata = objectAt(mapping.metadata ?? {}, '$.metadata')
  const categories = declarationsAt(metadata.categories, '$.metadata.categories')
  const labels = declarationsAt(metadata.labels, '$.metadata.labels')
  declarationsAt(metadata.sortKeys, '$.metadata.sortKeys', { sortKeys: true })
  const plugins = mapping.plugins
  if (!Array.isArray(plugins)) fail('$.plugins', 'must be an array')
  const names = new Set()
  plugins.forEach((entry, position) => {
    const path = `$.plugins[${position}]`
    const parsed = pluginAt(entry, path, categories, labels)
    if (names.has(parsed.name)) fail(`${path}.name`, `duplicates ${parsed.name}`)
    names.add(parsed.name)
  })
  localized(mapping.title, '$.title')
  if (mapping.description !== undefined && mapping.description !== null) {
    localized(mapping.description, '$.description')
  }
}

/** The bundle's own directory inside this repository, whichever layout it uses. */
function bundleDir(repo) {
  return BUNDLE_PATH === null ? repo : join(repo, BUNDLE_PATH)
}

/** The bundle's icon as an inline `data:` URL. */
export function bundleIcon(repo = REPO) {
  const svg = readFileSync(join(bundleDir(repo), 'icon.svg'))
  if (svg.length > MAX_INLINE_ICON_BYTES) {
    throw new Error(`the bundle icon is ${svg.length} bytes, over the ${MAX_INLINE_ICON_BYTES}-byte inline limit`)
  }
  return `data:image/svg+xml;base64,${svg.toString('base64')}`
}

/** The format-1 document listing this repository's bundle at one version. */
export function buildIndex({ version, commit, published, indexUrl = INDEX_URL, repo = REPO }) {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) {
    throw new IndexError('$.plugins[0].versions[0].source.commit', 'must be a lowercase 40-hex-digit commit SHA')
  }
  const document = {
    format: 1,
    title: { en: 'dkitchen', zh: 'dkitchen 厨房' },
    description: {
      en: 'A kitchen of DeepSeek Harness sessions: stations, tickets, long jobs, and the bell that wakes them.',
      zh: '用 DeepSeek Harness 会话开一间厨房：安排岗位、分发票、跑长任务，再读回结果。',
    },
    metadata: {
      categories: { workflow: { title: { en: 'Workflow', zh: '工作流' } } },
      labels: { official: { title: { en: 'Official', zh: '官方' } } },
    },
    plugins: [
      {
        name: 'dsh-dkitchen',
        title: { en: 'dkitchen', zh: 'dkitchen 厨房' },
        description: {
          en: "Call dkitchen's tools from any session: create stations, hand out tickets, launch long jobs, and read what came back.",
          zh: '在任何会话里调用 dkitchen 的工具：安排岗位、分发票、跑长任务，再读回结果。',
        },
        icon: bundleIcon(repo),
        author: '917Dhj',
        homepage: REPOSITORY_URL,
        repository: {
          url: REPOSITORY_URL,
          ...BUNDLE_PATH === null ? {} : { directory: BUNDLE_PATH },
        },
        metadata: {
          category: 'workflow',
          keywords: ['dsh-plugin', 'deepseek-harness', 'dkitchen', 'agent', 'orchestration', 'multi-agent'],
          labels: ['official'],
        },
        versions: [
          {
            version,
            publishTimestamp: published,
            source: {
              type: 'git',
              url: REPOSITORY_URL,
              commit,
              // Absent for a bundle at the repository root: the harness rejects a `.` segment
              // and omits `&path:/` when this is missing.
              ...BUNDLE_PATH === null ? {} : { path: BUNDLE_PATH },
            },
            engines: { dsh: DSH_RANGE },
          },
        ],
      },
    ],
  }
  validateIndex(document, indexUrl)
  return document
}

/** Write the document with a trailing newline, so a diff of it stays readable. */
export function writeIndex(path, document) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

// -- git facts -------------------------------------------------------------------------

function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim() || `git ${args.join(' ')} failed`)
  }
}

export function headCommit(repo = REPO) {
  return git(repo, 'rev-parse', 'HEAD')
}

export function commitTime(repo, commit) {
  return Number(git(repo, 'show', '-s', '--format=%ct', commit))
}

/** The version the bundle manifest declares. */
export function bundleVersion(repo = REPO) {
  const manifest = JSON.parse(readFileSync(join(bundleDir(repo), 'package.json'), 'utf8'))
  return String(manifest.version)
}

// -- command line ----------------------------------------------------------------------

function parseArgs(argv) {
  const options = { action: 'index', check: false, repo: REPO, indexUrl: INDEX_URL }
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]
    if (!argument.startsWith('--')) {
      options.action = argument
      continue
    }
    const name = argument.slice(2)
    if (name === 'check') {
      options.check = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    if (name === 'out') options.out = value
    else if (name === 'url') options.indexUrl = value
    else if (name === 'commit') options.commit = value
    else if (name === 'published') options.published = Number(value)
    else if (name === 'version') options.version = value
    else throw new Error(`unknown option --${name}`)
  }
  return options
}

/**
 * The command line, as a function so a test can drive it without a child process.
 *
 * Returns the exit code: 0 when the index was written or validated, 1 when the file is missing
 * or violates the format. A refusal prints the rule it broke, which is what a CI log needs.
 */
export function main(argv) {
  const options = parseArgs(argv)
  if (options.action !== 'index') throw new Error(`unknown market action: ${options.action}`)
  const out = options.out
    ? (isAbsolute(options.out) ? options.out : join(REPO, options.out))
    : join(REPO, 'docs', 'market', 'index.json')

  if (options.check) {
    let text
    try {
      text = readFileSync(out, 'utf8')
    } catch {
      console.log(`dkitchen: ${out} does not exist; run \`node scripts/market.mjs index\` first`)
      return 1
    }
    let document
    try {
      document = JSON.parse(text)
      validateIndex(document, options.indexUrl)
    } catch (error) {
      console.log(`dkitchen: ${out} is not a valid format-1 index: ${error.message}`)
      return 1
    }
    console.log(`dkitchen: ${out} is a valid format-1 index (${document.plugins.map((p) => p.name).join(', ')})`)
    return 0
  }

  const commit = options.commit ?? headCommit(options.repo)
  const published = Number.isInteger(options.published) ? options.published : commitTime(options.repo, commit)
  const version = options.version ?? bundleVersion(options.repo)
  const document = buildIndex({ version, commit, published, indexUrl: options.indexUrl, repo: options.repo })
  writeIndex(out, document)
  console.log(`dkitchen: wrote ${out} (dsh-dkitchen ${version} at ${commit.slice(0, 12)}, published ${published})`)
  console.log(`dkitchen: add this URL in the harness's Plugins > Discover tab:\n  ${options.indexUrl}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`dkitchen: ${error.message}`)
    process.exitCode = 1
  }
}
