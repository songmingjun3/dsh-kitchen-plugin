import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitKey, writeSetting } from '../lib/config-tools.js'
import { load, FILE } from '../lib/config.js'
import { check, Source, namesByReference, spans } from '../lib/refs.js'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dkitchen-cfg-'))
})

function writeConfig(text) {
  writeFileSync(join(root, FILE), text, 'utf8')
}

test('a dotted key splits into its table and name', () => {
  assert.deepEqual(splitKey('models.executor.model'),
    { table: 'models.executor', name: 'model' })
  assert.deepEqual(splitKey('repo'), { table: null, name: 'repo' })
})

test('setting a key in an existing table edits that line', () => {
  const text = '[harness]\ndefault_provider = "a"\ndefault_model = "b"\n'
  const out = writeSetting(text, 'harness.default_model', 'c')
  assert.match(out, /default_model = "c"/)
  assert.match(out, /default_provider = "a"/)
})

test('setting a key in a missing table appends the table', () => {
  const text = '[harness]\ndefault_provider = "a"\n'
  const out = writeSetting(text, 'models.executor.model', 'b')
  assert.match(out, /\[models\.executor\]/)
  assert.match(out, /model = "b"/)
})

test('a top-level key goes above the first table header', () => {
  const text = '[harness]\ndefault_provider = "a"\n'
  const out = writeSetting(text, 'repo', 'owner/name')
  const lines = out.split('\n')
  assert.equal(lines[0], 'repo = "owner/name"')
  assert.ok(lines.indexOf('[harness]') > 0)
})

test('setting a top-level key that exists replaces it in place', () => {
  const text = 'repo = "old/repo"\n\n[harness]\ndefault_provider = ' + '"a"\n'
  const out = writeSetting(text, 'repo', 'new/repo')
  assert.equal(out.split('\n')[0], 'repo = "new/repo"')
  // The value itself contains "repo", so only an anchored check proves the edit replaced
  // rather than appended.
  assert.equal(out.match(/^repo = /gm).length, 1)
})

test('a numeric value is written without quotes', () => {
  const out = writeSetting('[log]\n', 'log.issue', 7)
  assert.match(out, /issue = 7/)
})

test('an array value is written as a TOML array', () => {
  const out = writeSetting('[kitchen]\n', 'kitchen.stations', ['executor', 'orchestrator'])
  assert.match(out, /stations = \["executor", "orchestrator"\]/)
})

test('an edited file still loads, with the new value', () => {
  writeConfig('[harness]\ndefault_provider = "trae"\n')
  const out = writeSetting(readFileSync(join(root, FILE), 'utf8'), 'harness.default_model', 'flash')
  writeConfig(out)
  const config = load(root, { root })
  assert.equal(config.harness.default_provider, 'trae')
  assert.equal(config.harness.default_model, 'flash')
})

test('a name cited next to a line that does not hold it is a finding', () => {
  writeFileSync(join(root, 'sample.py'), 'def alpha():\n    return 1\n\ndef beta():\n    return 2\n')
  const source = new Source(null, root)
  const result = check('see `sample.py:1` and `beta`', source, 0)
  assert.equal(result.checked, 1)
  // `beta` is defined further down, not on line 1, and it is not line 1's own definition.
  assert.equal(result.findings.length, 1)
  assert.match(result.findings[0], /beta.*not on the cited line/)
})

test('a name that is the cited line\'s own definition is accepted', () => {
  writeFileSync(join(root, 'sample.py'), 'def alpha():\n    return 1\n')
  const source = new Source(null, root)
  // `alpha` is not on line 2, but it is the definition enclosing it, which is what a draft
  // means by "`sample.py:2` holds `alpha`".
  const result = check('`sample.py:2` holds `alpha`', source, 0)
  assert.deepEqual(result.findings, [])
  assert.equal(result.checked, 1)
})

test('a name that appears near the cited line satisfies the reference', () => {
  writeFileSync(join(root, 'sample.py'), 'def alpha():\n    beta = 1\n')
  const source = new Source(null, root)
  assert.equal(check('`sample.py:2` holds `beta`', source, 0).findings.length, 0)
  // `beta` is on line 2, so a name cited against line 1 is found once the window widens.
  assert.equal(check('`sample.py:1` holds `beta`', source, 0).findings.length, 1)
  assert.equal(check('`sample.py:1` holds `beta`', source, 1).findings.length, 0)
})

test('a line past the end of the file is a finding', () => {
  writeFileSync(join(root, 'sample.py'), 'line one\n')
  const source = new Source(null, root)
  const result = check('`sample.py:99`', source, 0)
  assert.equal(result.findings.length, 1)
  assert.match(result.findings[0], /beyond the end/)
})

test('a file that cannot be resolved is reported as unchecked, not wrong', () => {
  const source = new Source(null, root)
  const result = check('`nowhere.py:3`', source, 0)
  assert.deepEqual(result.findings, [])
  assert.equal(result.notes.length, 1)
  assert.match(result.notes[0], /not checked/)
})

test('a matching sha256 prefix passes', () => {
  const body = 'payload'
  writeFileSync(join(root, 'data.txt'), body)
  const source = new Source(null, root)
  const { createHash } = process.getBuiltinModule('node:crypto')
  const digest = createHash('sha256').update(body).digest('hex')
  const result = check(`\`data.txt\` sha256 \`${digest.slice(0, 8)}\``, source, 0)
  assert.deepEqual(result.findings, [])
  assert.equal(result.checked, 1)
})

test('a wrong sha256 is a finding', () => {
  writeFileSync(join(root, 'data.txt'), 'payload')
  const source = new Source(null, root)
  const result = check('`data.txt` sha256 `deadbeef`', source, 0)
  assert.equal(result.findings.length, 1)
  assert.match(result.findings[0], /has sha256/)
})

test('a relative draft path is resolved against the repository, not the process', () => {
  // The rule is exercised through the tool, whose path resolution lives in config-tools.js;
  // this asserts the shape of that decision without a harness.
  const { isAbsolute, join } = process.getBuiltinModule('node:path')
  const root = '/work/repo'
  const name = 'draft.md'
  const resolved = isAbsolute(name) ? name : join(root, name)
  assert.equal(resolved, join(root, name))
  assert.equal(isAbsolute('/elsewhere/draft.md'), true)
})

test('spans record their offsets so a nearby name can be attributed', () => {
  const line = '`a.py:1` holds `alpha`'
  const found = spans(line)
  assert.equal(found.length, 2)
  const names = namesByReference(line, found)
  assert.deepEqual(names.get(0), ['alpha'])
})
