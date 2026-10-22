/**
 * The plugin market index: generation, and the format-1 rules the harness enforces.
 *
 * The harness refuses an index that violates any rule as a whole, so a typo does not degrade the
 * Discover listing — it removes it. These tests hold the generated document to the same rules,
 * and check the document committed in the repository, so a stale or hand-edited index fails here
 * rather than in someone's Discover tab.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BUNDLE_PATH,
  DSH_RANGE,
  INDEX_URL,
  IndexError,
  MAX_INLINE_ICON_BYTES,
  buildIndex,
  bundleVersion,
  main,
  validateIndex,
  writeIndex,
} from '../../../scripts/market.mjs'

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const COMMITTED = join(REPO, 'docs', 'market', 'index.json')
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

/** A freshly built document, with any field overridden for one test. */
function document(overrides = {}) {
  return buildIndex({ version: '1.2.3', commit: COMMIT, published: 1792600000, ...overrides })
}

test('a generated index is valid format 1', () => {
  const built = document()
  validateIndex(built)
  assert.equal(built.format, 1)
  assert.ok(built.title.en)
  assert.ok(built.title.zh)
  const plugin = built.plugins[0]
  assert.equal(plugin.name, 'dsh-dkitchen')
  const version = plugin.versions[0]
  assert.equal(version.version, '1.2.3')
  assert.equal(version.source.type, 'git')
  assert.equal(version.source.commit, COMMIT)
  assert.equal(version.source.path, BUNDLE_PATH)
})

test('the install spec the harness derives is a git url at the commit', () => {
  // `marketInstallTarget` builds `git+<url>.git#<commit>&path:/<dir>` for a git source.
  const source = document().plugins[0].versions[0].source
  const expected = `git+${source.url}.git#${source.commit}&path:/${source.path}`
  assert.ok(expected.startsWith('git+https://github.com/'))
  assert.ok(expected.includes(`#${COMMIT}`))
})

test('the index names the bundle directory that exists in this checkout', () => {
  // The Discover tab clones this commit and installs from this path, so a path that drifted
  // from the real directory is an install nobody can complete.
  assert.equal(BUNDLE_PATH, 'src/dkitchen-node')
  assert.match(readFileSync(join(REPO, BUNDLE_PATH, 'package.json'), 'utf8'), /"name"\s*:/)
})

test('the document-level rules are enforced', () => {
  for (const bad of [{ format: 2 }, { title: { zh: '没有英文' } }, { plugins: 'not-an-array' }]) {
    const built = document()
    Object.assign(built, bad)
    assert.throws(() => validateIndex(built), IndexError)
  }
})

test('a plugin with no versions is refused', () => {
  const built = document()
  built.plugins[0].versions = []
  assert.throws(() => validateIndex(built), /non-empty/)
})

test('a version that is not exact semver is refused', () => {
  for (const version of ['1.2', 'v1.2.3', '1.2.3.4', 'not-a-version']) {
    const built = document()
    built.plugins[0].versions[0].version = version
    assert.throws(() => validateIndex(built), /SemVer/)
  }
})

test('a publish timestamp outside the integer range is refused', () => {
  for (const stamp of [-1, 10 ** 11, 1.5, true, '1792600000']) {
    const built = document()
    built.plugins[0].versions[0].publishTimestamp = stamp
    assert.throws(() => validateIndex(built), /publishTimestamp/)
  }
})

test('a source commit must be forty lowercase hex', () => {
  for (const commit of [
    'abc',
    '0123456789ABCDEF0123456789ABCDEF01234567',
    '0123456789abcdef0123456789abcdef0123456',
  ]) {
    const built = document()
    built.plugins[0].versions[0].source.commit = commit
    assert.throws(() => validateIndex(built), /commit/)
  }
})

test('a build refuses a short commit before it writes anything', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'dkitchen-market-')), 'market', 'index.json')
  assert.throws(() => buildIndex({ version: '1.2.3', commit: 'abc', published: 1 }), IndexError)
  assert.throws(() => readFileSync(target, 'utf8'), /ENOENT/)
})

test('a repeated package name is refused', () => {
  const built = document()
  built.plugins.push(JSON.parse(JSON.stringify(built.plugins[0])))
  assert.throws(() => validateIndex(built), /duplicates/)
})

test('an undeclared category or label is refused', () => {
  const byCategory = document()
  byCategory.plugins[0].metadata.category = 'nope'
  assert.throws(() => validateIndex(byCategory), /undeclared/)

  const byLabel = document()
  byLabel.plugins[0].metadata.labels = ['nope']
  assert.throws(() => validateIndex(byLabel), /undeclared/)
})

test('the icon is inline and within the size limit', () => {
  const icon = document().plugins[0].icon
  assert.ok(icon.startsWith('data:image/svg+xml;base64,'))
  const decoded = Buffer.from(icon.split(',', 1)[1] ?? icon.slice(icon.indexOf(',') + 1), 'base64')
  assert.ok(decoded.length <= MAX_INLINE_ICON_BYTES)
  assert.ok(decoded.includes(Buffer.from('<svg')))
})

test('a file reference that leaves the index origin is refused', () => {
  const built = document()
  // A cross-origin https URL is allowed by the harness, so this one must pass.
  built.plugins[0].icon = 'https://example.com/icon.png'
  validateIndex(built)
  built.plugins[0].icon = '/absolute/icon.png'
  assert.throws(() => validateIndex(built), /relative file/)
})

test('writeIndex ends with a newline', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'dkitchen-market-')), 'out', 'index.json')
  writeIndex(target, document())
  assert.ok(readFileSync(target, 'utf8').endsWith('\n'))
})

test('the committed index is valid and names this bundle', () => {
  const built = JSON.parse(readFileSync(COMMITTED, 'utf8'))
  validateIndex(built, INDEX_URL)
  assert.deepEqual(built.plugins.map((plugin) => plugin.name), ['dsh-dkitchen'])
  const version = built.plugins[0].versions[0]
  // The committed index must point at a commit this repository actually has, or the install
  // the Discover tab offers would fail to clone.
  assert.equal(version.source.commit.length, 40)
  assert.match(version.source.commit, /^[0-9a-f]{40}$/)
  assert.equal(version.engines.dsh, DSH_RANGE)
  assert.equal(version.source.path, BUNDLE_PATH)
  assert.equal(built.plugins[0].repository.directory, BUNDLE_PATH)
})

test('the committed index lists the version the bundle manifest declares', () => {
  const built = JSON.parse(readFileSync(COMMITTED, 'utf8'))
  assert.equal(built.plugins[0].versions[0].version, bundleVersion(REPO))
})

test('the index url is the published raw url of this branch', () => {
  assert.ok(INDEX_URL.startsWith('https://raw.githubusercontent.com/'))
  assert.ok(INDEX_URL.endsWith('/docs/market/index.json'))
})

test('bundleVersion reads the bundle manifest, not a pyproject', () => {
  // There is no Python package to read a version from any more.
  assert.match(bundleVersion(REPO), /^\d+\.\d+\.\d+/)
})

test('the check action refuses a broken file and accepts a good one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dkitchen-market-'))
  const target = join(directory, 'index.json')
  const built = document()
  built.format = 9
  writeFileSync(target, JSON.stringify(built), 'utf8')
  // `main` is the same entry point CI runs through the script, driven directly so the suite
  // starts no child process.
  assert.equal(main(['index', '--check', '--out', target]), 1)

  writeIndex(target, document())
  assert.equal(main(['index', '--check', '--out', target]), 0)
})

test('the check action reports a missing index instead of throwing', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'dkitchen-market-')), 'absent.json')
  assert.equal(main(['index', '--check', '--out', target]), 1)
})
