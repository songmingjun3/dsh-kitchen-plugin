import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load, ConfigError, FILE, STATIONS } from '../lib/config.js'

/** A throwaway repository with an optional `.dkitchen.toml`. */
function repo(toml) {
  const root = mkdtempSync(join(tmpdir(), 'dkitchen-cfg-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  if (toml !== undefined) writeFileSync(join(root, FILE), toml, 'utf8')
  return root
}

test('a repository with no file gets the English defaults', () => {
  const config = load(repo(), { root: undefined })
  assert.deepEqual(config.kitchen.stations, STATIONS)
  assert.equal(config.harness.default_provider, 'deepseek-official')
  assert.equal(config.harness.default_model, 'deepseek-v4-flash')
  assert.deepEqual(config.status.fields, ['Status', 'Waiting on', 'Key numbers', 'Next'])
  assert.equal(config.sessions.name, '【#{issue}】{name}')
  assert.equal(config.repo, null)
})

test('an explicit root is used without asking git', () => {
  const root = repo('[harness]\ndefault_provider = "trae"\n')
  assert.equal(load(root, { root }).harness.default_provider, 'trae')
})

test('a file with no [harness] still resolves one, but does not claim to have declared it', () => {
  // Every resolved configuration carries a provider and a model, because `withHelpers` fills
  // them in. `declared` is the only honest answer to "did this repository choose its route?",
  // and the bundle's station defaults depend on it.
  const none = load(repo(), { root: undefined })
  assert.equal(none.harness.default_provider, 'deepseek-official')
  assert.equal(none.declared.harness, false)
  assert.equal(none.declared.models, false)
})

test('a file that writes [harness] or [models] is recorded as having declared it', () => {
  const withHarness = load(repo('[harness]\ndefault_provider = "trae"\n'), { root: undefined })
  assert.equal(withHarness.declared.harness, true)

  const withModels = load(repo('[models.executor]\nmodel = "x"\n'), { root: undefined })
  assert.equal(withModels.declared.models, true)
  assert.equal(withModels.declared.harness, false)
})

test('a station route falls back to the harness default field by field', () => {
  const root = repo([
    '[harness]',
    'default_provider = "trae"',
    'default_model = "flash"',
    '[models.executor]',
    'model = "v4.1"',
  ].join('\n'))
  const config = load(root, { root })
  assert.deepEqual(config.route('executor'), {
    provider: 'trae', model: 'v4.1', effort: null,
  })
  assert.deepEqual(config.route('verifier'), {
    provider: 'trae', model: 'flash', effort: null,
  })
})

test('the kitchen keeps the canonical station order, not the file order', () => {
  const root = repo('[kitchen]\nstations = ["executor", "orchestrator"]\n')
  assert.deepEqual(load(root, { root }).kitchen.stations, ['orchestrator', 'executor'])
})

test('a session name template fills issues, names, and the repository', () => {
  const root = repo('[sessions]\nname = "{repo}#{issue} {name}"\n')
  const config = load(root, { root })
  assert.equal(config.sessionName({ issue: 7, name: 'Ablation', repo: 'o/n' }), 'o/n#7 Ablation')
})

test('the separator is the one string allowed to be empty', () => {
  const root = repo('[stations]\nseparator = ""\n')
  const config = load(root, { root })
  assert.equal(config.signature('Executor'), 'Executor')
})

test('an unknown top-level key is refused', () => {
  assert.throws(() => load(repo('nope = 1\n'), { root: undefined }), /unknown keys: nope/)
})

test('an unknown key inside a table is refused, naming the table', () => {
  assert.throws(() => load(repo('[harness]\nbogus = "x"\n'), { root: undefined }),
    /unknown keys in \[harness\]: bogus/)
})

test('an unknown station is refused with the legal set', () => {
  assert.throws(() => load(repo('[kitchen]\nstations = ["chef"]\n'), { root: undefined }),
    /unknown stations: chef/)
})

test('a repeated station is refused', () => {
  assert.throws(() => load(repo('[kitchen]\nstations = ["executor", "executor"]\n'), { root: undefined }),
    /names a station twice/)
})

test('an empty station list is refused', () => {
  assert.throws(() => load(repo('[kitchen]\nstations = []\n'), { root: undefined }),
    /nonempty list of station names/)
})

test('approvals accepts only auto or ask', () => {
  assert.throws(() => load(repo('[harness]\napprovals = "never"\n'), { root: undefined }),
    /approvals must be 'auto' or 'ask'/)
})

test('a route key must be a nonempty string', () => {
  assert.throws(() => load(repo('[models.executor]\nprovider = ""\n'), { root: undefined }),
    /provider must be a nonempty string/)
})

test('a repo value must look like owner/name', () => {
  assert.throws(() => load(repo('repo = "not a repo"\n'), { root: undefined }),
    /repo must look like owner\/name/)
})

test('an issue must be a positive integer', () => {
  assert.throws(() => load(repo('[log]\nissue = 0\n'), { root: undefined }), /positive issue number/)
  assert.throws(() => load(repo('[log]\nissue = "1"\n'), { root: undefined }), /positive issue number/)
})

test('a session template may not name an unknown field', () => {
  assert.throws(() => load(repo('[sessions]\nname = "{ticket}"\n'), { root: undefined }),
    /name uses \{ticket\}/)
})

test('status fields must be a nonempty list of names', () => {
  assert.throws(() => load(repo('[status]\nfields = []\n'), { root: undefined }),
    /fields must be a nonempty list/)
})

test('a TOML syntax error is reported with its line', () => {
  assert.throws(() => load(repo('[harness\nbogus = "x"\n'), { root: undefined }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /line|unterminated/)
      return true
    })
})

test('an empty file means the defaults, not an error', () => {
  const config = load(repo(''), { root: undefined })
  assert.deepEqual(config.kitchen.stations, STATIONS)
})

test('a UTF-8 byte-order mark is refused, as tomllib refuses it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dkitchen-bom-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, FILE), '\ufeff[harness]\napprovals = "ask"\n', 'utf8')
  assert.throws(() => load(root, { root }), /byte-order mark/)
})

test('legacy signature lines still count as a signature', () => {
  const config = load(repo('[sessions]\nowner_line = "DSH owner"\n'), { root: undefined })
  assert.deepEqual(config.ownerPatterns(), ['DSH owner', 'Codex owner'])
  assert.deepEqual(config.sessionPatterns(), ['DSH session', 'Codex session'])
})
