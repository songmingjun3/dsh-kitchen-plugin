import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseToml, TomlError } from '../lib/toml.js'

test('a table header followed by keys becomes a nested object', () => {
  const parsed = parseToml('[kitchen]\nstations = ["orchestrator", "executor"]\n')
  assert.deepEqual(parsed, { kitchen: { stations: ['orchestrator', 'executor'] } })
})

test('a dotted table header nests two levels', () => {
  const parsed = parseToml('[models.executor]\nprovider = "trae"\nmodel = "deepseek-v4.1-flash"\n')
  assert.deepEqual(parsed, { models: { executor: { provider: 'trae', model: 'deepseek-v4.1-flash' } } })
})

test('a top-level key before any header stays at the root', () => {
  const parsed = parseToml('repo = "owner/name"\n[harness]\napprovals = "auto"\n')
  assert.deepEqual(parsed, { repo: 'owner/name', harness: { approvals: 'auto' } })
})

test('comments are stripped, including a hash inside a string', () => {
  const parsed = parseToml(
    '# a comment\n[sessions]   # trailing\nname = "【#{issue}】{name}"  # the template\n',
  )
  assert.equal(parsed.sessions.name, '【#{issue}】{name}')
})

test('integers and booleans keep their type', () => {
  const parsed = parseToml('[log]\nissue = 1\n[publish]\npin = true\n')
  assert.equal(parsed.log.issue, 1)
  assert.equal(parsed.publish.pin, true)
})

test('an escaped quote inside a basic string survives', () => {
  const parsed = parseToml('[stations]\nseparator = "a\\"b"\n')
  assert.equal(parsed.stations.separator, 'a"b')
})

test('a literal string keeps backslashes as written', () => {
  const parsed = parseToml("[stations]\nseparator = 'C:\\path'\n")
  assert.equal(parsed.stations.separator, 'C:\\path')
})

test('an array may span lines and allow a trailing comma', () => {
  const parsed = parseToml('[status]\nfields = [\n  "Status",\n  "Waiting on",\n]\n')
  assert.deepEqual(parsed.status.fields, ['Status', 'Waiting on'])
})

test('an empty array is allowed', () => {
  assert.deepEqual(parseToml('list = []\n').list, [])
})

test('a value repeated in one table is refused with its line', () => {
  assert.throws(() => parseToml('[log]\nissue = 1\nissue = 2\n'), (error) => {
    assert.ok(error instanceof TomlError)
    assert.equal(error.line, 3)
    assert.match(error.message, /already defined/)
    return true
  })
})

test('a dotted key is refused instead of guessed', () => {
  assert.throws(() => parseToml('a.b = 1\n'), (error) => {
    assert.match(error.message, /dotted keys are not supported/)
    return true
  })
})

test('floats and dates are refused, because a kitchen has no use for them', () => {
  assert.throws(() => parseToml('x = 1.5\n'), /floats are not supported/)
  assert.throws(() => parseToml('x = 2026-10-22\n'), /dates are not supported/)
})

test('an array of tables is refused', () => {
  assert.throws(() => parseToml('[[models]]\nprovider = "x"\n'), /arrays of tables/)
})

test('an unterminated string names its line', () => {
  assert.throws(() => parseToml('[a]\nb = "unterminated\n'), (error) => {
    assert.equal(error.line, 2)
    assert.match(error.message, /unterminated string/)
    return true
  })
})

test('text after a value is refused rather than ignored', () => {
  assert.throws(() => parseToml('a = "x" "y"\n'), /unexpected text after the value/)
})

test('a table name colliding with a value is refused', () => {
  assert.throws(() => parseToml('repo = "a/b"\n[repo]\nx = "y"\n'), /already a value, not a table/)
})

test('the shipped example config parses into the shape config.js expects', () => {
  const text = [
    'repo = "owner/name"',
    '[kitchen]',
    'stations = ["orchestrator", "designer", "verifier", "executor"]',
    '[harness]',
    'profile = "dkitchen"',
    'approvals = "auto"',
    '[models.executor]',
    'provider = "trae"',
    'model = "deepseek-v4.1-flash"',
    'effort = "high"',
    '[status]',
    'fields = ["Status", "Waiting on", "Key numbers", "Next"]',
    '[log]',
    'issue = 7',
  ].join('\n')
  const parsed = parseToml(text)
  assert.equal(parsed.repo, 'owner/name')
  assert.equal(parsed.kitchen.stations.length, 4)
  assert.equal(parsed.models.executor.effort, 'high')
  assert.equal(parsed.log.issue, 7)
})
