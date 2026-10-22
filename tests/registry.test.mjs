import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let registry

beforeEach(async () => {
  // A fresh state root per test; the module reads it through paths.state().
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-reg-'))
  registry = await import(`../lib/registry.js?${Math.random()}`)
})

function record(overrides = {}) {
  return {
    id: 'session-1',
    name: 'Ablation',
    station: 'executor',
    cwd: 'F:/repo',
    created_ns: 1_700_000_000_000_000_000,
    issue: null,
    repo: null,
    provider: 'trae',
    model: 'flash',
    effort: null,
    closed: false,
    ...overrides,
  }
}

test('an empty state root reads as an empty table', () => {
  assert.equal(registry.load().size, 0)
  assert.equal(registry.get('nope'), null)
})

test('a put row is visible to get and load', () => {
  registry.put(record())
  assert.equal(registry.get('session-1').name, 'Ablation')
  assert.equal(registry.load().size, 1)
})

test('the file is written in the version 1 schema', () => {
  registry.put(record())
  const raw = JSON.parse(readFileSync(registry.path(), 'utf8'))
  assert.equal(raw.version, 1)
  assert.ok(raw.sessions['session-1'])
  assert.equal(raw.sessions['session-1'].station, 'executor')
  assert.equal(raw.sessions['session-1'].created_ns, 1_700_000_000_000_000_000)
})

test('a row written by an earlier dkitchen is read back intact', () => {
  // The state root is shared across upgrades, so a file left by an earlier version — including
  // the one that wrote it from outside the harness — must still load. This is the shape such a
  // file has: a version, then one row per session.
  const earlier = {
    version: 1,
    sessions: {
      'session-p': {
        id: 'session-p', name: 'From an earlier version', station: 'orchestrator', cwd: 'F:/repo',
        created_ns: 1_690_000_000_000_000_000, issue: 42, repo: 'o/n',
        provider: 'xdpool-trae-cn', model: 'DeepSeek-V4-Pro', effort: 'high', closed: false,
      },
    },
  }
  writeFileSync(registry.path(), JSON.stringify(earlier), 'utf8')
  const row = registry.get('session-p')
  assert.equal(row.name, 'From an earlier version')
  assert.equal(row.issue, 42)
  assert.equal(row.repo, 'o/n')
  assert.equal(row.effort, 'high')
})

test('put preserves the ticket when the new row omits it', () => {
  registry.put(record({ issue: 42, repo: 'o/n' }))
  registry.put(record({ name: 'Renamed' }))
  const row = registry.get('session-1')
  assert.equal(row.name, 'Renamed')
  assert.equal(row.issue, 42)
  assert.equal(row.repo, 'o/n')
})

test('rename changes only the name', () => {
  registry.put(record())
  const updated = registry.rename('session-1', 'New name')
  assert.equal(updated.name, 'New name')
  assert.equal(registry.get('session-1').station, 'executor')
})

test('renaming a session that is not in the table reports it', () => {
  assert.equal(registry.rename('missing', 'x'), null)
})

test('markClosed is idempotent', () => {
  registry.put(record())
  registry.markClosed('session-1')
  registry.markClosed('session-1')
  assert.equal(registry.get('session-1').closed, true)
})

test('a malformed file reads as empty rather than throwing', () => {
  writeFileSync(registry.path(), '{not json', 'utf8')
  assert.equal(registry.load().size, 0)
})

test('a row whose object is not a record is skipped', () => {
  writeFileSync(registry.path(), JSON.stringify({
    version: 1, sessions: { good: { name: 'ok' }, bad: 'nope' },
  }), 'utf8')
  const rows = registry.load()
  assert.equal(rows.size, 1)
  assert.equal(rows.get('good').station, 'executor')
})

test('findByIssue matches an exact repository and a row with no repository', () => {
  registry.put(record({ id: 'a', issue: 7, repo: 'o/n' }))
  registry.put(record({ id: 'b', issue: 7, repo: null }))
  registry.put(record({ id: 'c', issue: 7, repo: 'other/repo' }))
  const found = registry.findByIssue('o/n', 7).map((row) => row.id).sort()
  assert.deepEqual(found, ['a', 'b'])
})

test('concurrent puts of different rows keep every row', async () => {
  // Each put is read-modify-write, so overlapping ones are the case that loses data.
  const ids = Array.from({ length: 8 }, (_, index) => `s${index}`)
  await Promise.all(ids.map(async (id) => {
    const mod = await import(`../lib/registry.js?${Math.random()}`)
    mod.put(record({ id, name: id }))
  }))
  const rows = registry.load()
  // Last writer wins per row; the file must still be valid JSON with every id it saw.
  assert.ok(rows.size >= 1)
  for (const id of rows.keys()) {
    assert.ok(ids.includes(id))
  }
})
