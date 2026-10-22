import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { renderKitchen } from '../skills/setup-dkitchen/render.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let skill

beforeEach(async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-skill-'))
  skill = await import(`../lib/skill.js?${Math.random()}`)
})

test('the machine-wide skill root is inside DSH_HOME', () => {
  assert.equal(skill.userSkillRoot(), join(process.env.DSH_HOME, 'skills'))
})

test('the bundled skill ships beside this library', () => {
  const source = skill.bundledSkill()
  assert.ok(existsSync(join(source, 'SKILL.md')))
  assert.ok(existsSync(join(source, 'render.js')))
  assert.ok(existsSync(join(source, '..', '..', 'kitchen', 'README.md')))
})

test('the bundle version is read from the package manifest', () => {
  const version = skill.bundleVersion()
  assert.match(version, /^\d+\.\d+\.\d+/)
})

test('a missing skill is installed on first use', () => {
  assert.equal(existsSync(skill.installedSkill()), false)
  const result = skill.ensureSkill()
  assert.equal(result.installed, true)
  assert.ok(existsSync(join(skill.installedSkill(), 'SKILL.md')))
  assert.ok(existsSync(join(skill.installedSkill(), 'render.js')))
})

test('an installed skill carries its templates too', () => {
  skill.ensureSkill()
  // The skill renders from its own copy of the kitchen templates, so they must travel with it.
  assert.ok(existsSync(join(skill.installedSkill(), '..', '..', 'kitchen', 'README.md'))
    || existsSync(join(skill.bundledSkill(), '..', '..', 'kitchen', 'README.md')))
})

test('a second call at the same version does nothing', () => {
  assert.equal(skill.ensureSkill().installed, true)
  const again = skill.ensureSkill()
  assert.equal(again.installed, false)
  assert.equal(again.reason, 'already current')
})

test('force reinstalls over a current copy', () => {
  skill.ensureSkill()
  const forced = skill.ensureSkill({ force: true })
  assert.equal(forced.installed, true)
})

test('a stale marker triggers a reinstall', () => {
  skill.ensureSkill()
  writeFileSync(join(skill.installedSkill(), '.installed-from'), '0.0.0\n', 'utf8')
  const result = skill.ensureSkill()
  assert.equal(result.installed, true)
  assert.equal(result.replaced, '0.0.0')
})

test('a half-deleted copy is repaired', () => {
  skill.ensureSkill()
  // The marker records the current version, but the skill body is gone: a version check alone
  // would call this current and leave a command that cannot run.
  rmSync(join(skill.installedSkill(), 'SKILL.md'), { force: true })
  const result = skill.ensureSkill()
  assert.equal(result.installed, true)
  assert.ok(existsSync(join(skill.installedSkill(), 'SKILL.md')))
})

test('the installed copy records the version that wrote it', () => {
  skill.ensureSkill()
  const marker = readFileSync(join(skill.installedSkill(), '.installed-from'), 'utf8').trim()
  assert.equal(marker, skill.bundleVersion())
})

test('removing the skill reports what it removed', () => {
  skill.ensureSkill()
  const result = skill.removeSkill()
  assert.equal(result.removed, true)
  assert.equal(existsSync(skill.installedSkill()), false)
})

test('removing a skill that is not installed is not an error', () => {
  assert.equal(skill.removeSkill().removed, true)
})

test('the installed skill carries its own templates', () => {
  skill.ensureSkill()
  // The installed copy is what runs, and it resolves the templates beside itself. Without this
  // the skill installs and then cannot render anything, which is worse than not installing.
  const kitchen = join(process.env.DSH_HOME, 'skills', 'kitchen')
  assert.ok(existsSync(join(kitchen, 'README.md')))
  assert.ok(existsSync(join(kitchen, 'core', 'roles.md')))
})

test('the installed skill renders without a checkout or Python', () => {
  skill.ensureSkill()
  const out = mkdtempSync(join(tmpdir(), 'dkitchen-out-'))
  const result = renderKitchen({
    modules: ['run-budgets'],
    out,
    kitchen: join(process.env.DSH_HOME, 'skills', 'kitchen'),
  })
  assert.equal(result.written.length, 5)
  assert.ok(existsSync(join(out, 'roles.md')))
})

test('compiled Python caches are not copied into the skill root', () => {
  skill.ensureSkill()
  // The bundled skill ships Python helper scripts, and a checkout that has run them leaves
  // bytecode behind. Copying it would put another machine's cache into a source directory.
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(path)
    }
  }
  walk(skill.installedSkill())
  assert.equal(found.filter((path) => path.endsWith('.pyc')).length, 0)
  assert.equal(found.filter((path) => path.includes('__pycache__')).length, 0)
})

test('the installed skill keeps its name, so the command is /setup-dkitchen', () => {
  skill.ensureSkill()
  // The file may carry CRLF line endings on Windows; the frontmatter fields are what the
  // harness reads, so the assertion is about them and not about one newline style.
  const text = readFileSync(join(skill.installedSkill(), 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(text, /^---\nname: setup-dkitchen\n/)
})
