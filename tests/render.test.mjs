import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { render, blocks, renderKitchen, findKitchen, RenderError, MODULES, CORE } from '../skills/setup-dkitchen/render.js'

const KITCHEN = join(import.meta.dirname, '..', 'kitchen')

test('a chosen module keeps its block and drops the others', () => {
  const text = 'a<!-- module:run-budgets -->BUDGET<!-- /module:run-budgets -->'
    + 'b<!-- module:unattended -->AWAY<!-- /module:unattended -->c'
  assert.equal(render(text, ['run-budgets']), 'aBUDGETbc')
  assert.equal(render(text, ['unattended']), 'abAWAYc')
  assert.equal(render(text, []), 'abc')
})

test('a marker on its own line leaves no blank line behind', () => {
  const text = 'one\n<!-- module:run-budgets -->\ntwo\n<!-- /module:run-budgets -->\nthree\n'
  assert.equal(render(text, []), 'one\nthree\n')
})

test('three or more newlines collapse to one blank line', () => {
  // A dropped block leaves its surroundings; the collapse is what keeps the file readable.
  const text = 'a\n\n\n<!-- module:artifacts -->\n<!-- /module:artifacts -->\n\n\nb\n'
  assert.equal(render(text, []), 'a\n\nb\n')
})

test('a marker naming an unknown module is refused', () => {
  assert.throws(() => render('<!-- module:nope -->x<!-- /module:nope -->', []),
    (error) => error instanceof RenderError && /unknown module markers: nope/.test(error.message))
})

test('an unbalanced marker is refused rather than left in the output', () => {
  assert.throws(() => render('<!-- module:run-budgets -->x', []), /unbalanced module markers/)
})

test('the pointer block is keyed by its heading', () => {
  const text = '## AGENTS.md\n\n```markdown\nline one\nline two\n```\n\n## CLAUDE.md\n\n```markdown\n@AGENTS.md\n```\n'
  const found = blocks(text)
  assert.deepEqual(Object.keys(found).sort(), ['AGENTS.md', 'CLAUDE.md'])
  assert.equal(found['AGENTS.md'], 'line one\nline two')
  assert.equal(found['CLAUDE.md'], '@AGENTS.md')
})

test('the kitchen templates ship beside the skill', () => {
  const found = findKitchen()
  assert.equal(found, KITCHEN)
  assert.ok(CORE.every((name) => readFileSync(join(found, 'core', name), 'utf8').length > 0))
})

test('an explicit kitchen directory is honoured, and a wrong one is refused', () => {
  assert.equal(findKitchen(KITCHEN), KITCHEN)
  const empty = mkdtempSync(join(tmpdir(), 'dkitchen-nokitchen-'))
  assert.throws(() => findKitchen(empty), /not a kitchen folder/)
})

test('rendering the core set writes the four core files and no module files', () => {
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-render-'))
  const result = renderKitchen({ modules: [], out })
  assert.deepEqual(result.written.map((path) => path.slice(out.length + 1)).sort(), [...CORE].sort())
  assert.deepEqual(Object.keys(result.blocks).sort(), ['AGENTS.md', 'CLAUDE.md'])
})

test('rendering one module adds only that module file', () => {
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-render-'))
  const result = renderKitchen({ modules: ['run-budgets'], out })
  const names = result.written.map((path) => path.slice(out.length + 1))
  assert.ok(names.includes('run-budgets.md'))
  assert.ok(!names.includes('unattended.md'))
})

test('every rendered file is free of module markers', () => {
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-render-'))
  const result = renderKitchen({ modules: MODULES, out })
  for (const path of result.written) {
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /<!-- \/?module:/, `${path} still carries a module marker`)
  }
})

test('the fill placeholders survive, because the skill fills them', () => {
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-render-'))
  const result = renderKitchen({ modules: ['run-budgets', 'unattended'], out })
  const combined = result.written.map((path) => readFileSync(path, 'utf8')).join('\n')
  // These are left for the setup skill's step F, so rendering must not drop them.
  assert.match(combined, /<!-- fill: /)
})

test('an unknown module name is refused before anything is written', () => {
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-render-'))
  assert.throws(() => renderKitchen({ modules: ['nope'], out }), /unknown modules: nope/)
})

test('the pointer block names the files the kitchen installs', () => {
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-render-'))
  const result = renderKitchen({ modules: ['run-budgets'], out })
  const agents = result.blocks['AGENTS.md']
  assert.match(agents, /docs\/agents\/roles\.md/)
  assert.match(agents, /docs\/agents\/issue-tracker\.md/)
})
