import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeTarget, resolveTarget, sessionReferences, allReferences, displayCell, replyHead,
} from '../lib/target.js'

let registry
let root

beforeEach(async () => {
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-target-'))
  root = mkdtempSync(join(tmpdir(), 'dkitchen-repo-'))
  registry = await import(`../lib/registry.js?${Math.random()}`)
})

function config(overrides = {}) {
  const base = {
    root,
    repository: () => 'owner/repo',
    ownerPatterns: () => ['DSH owner'],
    sessionPatterns: () => ['DSH session'],
  }
  return { ...base, ...overrides }
}

function put(id, name) {
  registry.put({
    id, name, station: 'executor', cwd: 'F:/repo', created_ns: 0,
    issue: null, repo: null, provider: null, model: null, effort: null, closed: false,
  })
}

test('a full session id is accepted as-is', () => {
  const id = 'session-11111111-2222-3333-4444-555555555555'
  assert.equal(resolveTarget(id, null, config()), id)
})

test('a bare uuid gains the session- prefix the harness uses', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  assert.equal(resolveTarget(uuid, null, config()), `session-${uuid}`)
})

test('an exact name resolves to its session id', () => {
  put('session-a', 'Ablation')
  assert.equal(resolveTarget('Ablation', null, config()), 'session-a')
})

test('an ambiguous name lists the candidates instead of picking one', () => {
  put('session-a', 'Twin')
  put('session-b', 'Twin')
  assert.throws(() => resolveTarget('Twin', null, config()), (error) => {
    assert.match(error.message, /Found 2 sessions named 'Twin'/)
    assert.match(error.message, /session-a/)
    assert.match(error.message, /session-b/)
    return true
  })
})

test('a reused station name resolves to the live session, not the retired row', () => {
  put('session-old', '统筹')
  put('session-new', '统筹')
  const knownSessions = () => [{ id: 'session-new' }]
  assert.equal(resolveTarget('统筹', null, config(), { knownSessions }), 'session-new')
})

test('two live sessions sharing a name are still refused as ambiguous', () => {
  put('session-a', 'Twin')
  put('session-b', 'Twin')
  const knownSessions = () => [{ id: 'session-a' }, { id: 'session-b' }]
  assert.throws(() => resolveTarget('Twin', null, config(), { knownSessions }),
    /Found 2 sessions named 'Twin'/)
})

test('an unknown name reports what it does know', () => {
  put('session-a', 'Ablation')
  assert.throws(() => resolveTarget('nope', null, config()),
    /Found 0 sessions named 'nope'/)
})

test('a bare issue number expands through the configured repository', () => {
  // #7 with no dkitchen row and no gh available cannot resolve; it must say so clearly.
  assert.throws(() => resolveTarget('#7', null, config()), (error) => {
    assert.ok(/gh|owner\/repo#7/.test(error.message))
    return true
  })
})

test('an issue number passed separately is treated as the target', () => {
  assert.throws(() => resolveTarget(null, 0, config()), /positive issue number/)
})

test('an issue URL becomes OWNER/REPO#N', () => {
  assert.equal(
    normalizeTarget('https://github.com/owner/repo/issues/7', null, config()),
    'owner/repo#7',
  )
  assert.equal(
    normalizeTarget('https://github.com/owner/repo/pull/9', null, config()),
    'owner/repo#9',
  )
})

test('a non-github URL is refused', () => {
  assert.throws(() => normalizeTarget('https://example.com/x/issues/1', null, config()),
    /Issue URL must be/)
})

test('an OWNER/REPO#N target is left alone', () => {
  assert.equal(normalizeTarget('owner/repo#7', null, config()), 'owner/repo#7')
})

test('a malformed repository target is refused', () => {
  assert.throws(() => normalizeTarget('owner/../repo#7', null, config()),
    /OWNER\/REPO#/)
})

test('an empty target is refused with guidance', () => {
  assert.throws(() => resolveTarget(null, null, config()), /Name a session, a ticket, or an issue URL/)
})

test('owner and signature lines are read from a body under every accepted spelling', () => {
  const body = [
    'Some text',
    'DSH owner: session-abc',
    'DSH session: `session-def`',
    'Codex owner: session-legacy',
  ].join('\n')
  assert.deepEqual(sessionReferences(body, 'DSH owner'), ['session-abc'])
  const cfg = config({
    ownerPatterns: () => ['DSH owner', 'Codex owner'],
    sessionPatterns: () => ['DSH session', 'Codex session'],
  })
  assert.deepEqual(allReferences(body, cfg, { owner: true }), ['session-abc', 'session-legacy'])
  assert.deepEqual(allReferences(body, cfg, { owner: false }), ['session-def'])
})

test('a label that appears inside a longer word is not matched', () => {
  const body = 'xDSH owner: session-abc'
  assert.deepEqual(sessionReferences(body, 'DSH owner'), [])
})

test('displayCell escapes the way a JSON string does', () => {
  assert.equal(displayCell('a"b'), 'a\\"b')
  assert.equal(displayCell('plain'), 'plain')
})

test('replyHead keeps only the first paragraph', () => {
  assert.equal(replyHead('first\n\nsecond'), 'first')
  assert.equal(replyHead('only one'), 'only one')
  assert.equal(replyHead('a\r\n\r\nb'), 'a')
})
