/**
 * Render the kitchen templates for a chosen set of modules.
 *
 * The templates mark optional blocks with `<!-- module:name -->` … `<!-- /module:name -->`;
 * rendering keeps the blocks whose module was chosen and drops the rest, then removes every
 * marker so the output carries no trace of the mechanism. `<!-- fill: … -->` gaps are left
 * alone: the setup skill fills them with the repository's own facts.
 *
 * This runs in JavaScript so that the setup skill needs nothing but Node, which the harness
 * already provides — the skill is installed into a repository that may have no other runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MODULES = ['run-budgets', 'model-text', 'artifacts', 'unattended']
export const CORE = ['roles.md', 'issue-tracker.md', 'messaging.md', 'long-running-jobs.md']

/** Every marker pair, with everything between them. */
const SECTION = /<!-- module:([\w-]+) -->([\s\S]*?)<!-- \/module:\1 -->/g

/** A marker occupying its own line leaves no line behind. */
const MARKER_LINE = /^[ \t]*(<!-- \/?module:[\w-]+ -->)[ \t]*\n/gm

export class RenderError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RenderError'
  }
}

/**
 * Keep the chosen modules' text, drop the rest, remove every marker.
 *
 * A marker naming a module outside the vocabulary is refused rather than ignored: a typo in a
 * template would otherwise silently drop the block it was meant to keep.
 */
export function render(text, modules) {
  const chosen = new Set(modules)
  const source = normalized(text)
  const names = new Set()
  for (const match of source.matchAll(new RegExp(SECTION.source, 'g'))) {
    names.add(match[1])
  }
  const unknown = [...names].filter((name) => !MODULES.includes(name)).sort()
  if (unknown.length) {
    throw new RenderError(`unknown module markers: ${unknown.join(', ')}`)
  }

  let output = source.replace(MARKER_LINE, '$1')
  output = output.replace(new RegExp(SECTION.source, 'g'), (whole, name, body) => (
    chosen.has(name) ? body : ''
  ))
  if (output.includes('<!-- module:') || output.includes('<!-- /module:')) {
    throw new RenderError('unbalanced module markers')
  }
  return output.replace(/\n{3,}/g, '\n\n')
}

/**
 * A template's text with every line ending normalized to `\n`.
 *
 * A Windows checkout can hand us CRLF — `core.autocrlf=true` is the default there, and a
 * repository may also be committed with CRLF. The marker and fence patterns below are written
 * against `\n`, so without this a CRLF template renders to files that still carry their module
 * markers, and the pointer block comes back empty. Normalizing on read keeps the patterns
 * simple and makes the output identical on every platform.
 */
export function normalized(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

/**
 * The fenced Markdown blocks of `agents-block.md`, keyed by the heading above each.
 *
 * The heading is the `## ` line; the body is what sits between the fences, without its own
 * leading and trailing newlines.
 */
export function blocks(text) {
  const found = {}
  const pattern = /^## (\S+)\n\n```markdown\n([\s\S]*?)^```/gm
  for (const match of normalized(text).matchAll(pattern)) {
    found[match[1]] = match[2].replace(/^\n+|\n+$/g, '')
  }
  return found
}

/**
 * The `kitchen/` template folder.
 *
 * The templates travel with the skill, so an install renders them without a checkout. Three
 * layouts are possible and all are tried, because a skill directory ends up in more than one
 * place:
 *
 * - beside the skill, `../kitchen` — what an installed copy under the machine-wide skill root
 *   looks like;
 * - two levels up, `../../kitchen` — this bundle's own layout, where the skill sits under
 *   `skills/` inside the package;
 * - a `kitchen/` beside the current directory, which is what a checkout looks like.
 */
export function findKitchen(explicit) {
  if (explicit) {
    const directory = resolve(explicit)
    if (!existsSync(join(directory, 'README.md'))) {
      throw new RenderError(`${directory} is not a kitchen folder: no README.md`)
    }
    return directory
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '..', 'kitchen'),
    resolve(here, '..', '..', 'kitchen'),
    resolve(process.cwd(), 'kitchen'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'README.md'))) return candidate
  }
  throw new RenderError(
    'cannot find the kitchen/ templates; pass --kitchen DIR, or reinstall the bundle so it carries them',
  )
}

/**
 * Render every chosen template into `out`.
 *
 * Returns the files written and the rendered `AGENTS.md` / `CLAUDE.md` blocks, which the caller
 * wraps in the dkitchen markers and places in those files.
 */
export function renderKitchen({ modules = [], out, kitchen } = {}) {
  const chosen = new Set(modules)
  const unknown = [...chosen].filter((name) => !MODULES.includes(name))
  if (unknown.length) {
    throw new RenderError(`unknown modules: ${unknown.sort().join(', ')}`)
  }
  const source = findKitchen(kitchen)
  const files = [
    ...CORE.map((name) => join(source, 'core', name)),
    ...MODULES.filter((name) => chosen.has(name)).map((name) => join(source, 'modules', `${name}.md`)),
  ]
  const target = resolve(out)
  mkdirSync(target, { recursive: true })

  const written = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const rendered = render(text, chosen)
    // `basename`, not a split on '/': a Windows path uses backslashes, and splitting on the
    // wrong separator produces a "file name" that still holds the whole path.
    const destination = join(target, basename(file))
    writeFileSync(destination, rendered, 'utf8')
    written.push(destination)
  }

  const blockText = render(readFileSync(join(source, 'core', 'agents-block.md'), 'utf8'), chosen)
  return { written, blocks: blocks(blockText), kitchen: source }
}

/** The command line the setup skill runs: `render.js --modules … --out docs/agents`. */
function main(argv) {
  const options = { modules: [], out: null, kitchen: null }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--modules') {
      options.modules = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      index++
    } else if (flag === '--out') {
      options.out = value
      index++
    } else if (flag === '--kitchen') {
      options.kitchen = value
      index++
    } else if (flag === '--help' || flag === '-h') {
      console.log('usage: render.js --modules run-budgets,unattended --out docs/agents [--kitchen DIR]')
      return 0
    }
  }
  if (!options.out) {
    console.error('render.js: --out is required (for example docs/agents)')
    return 2
  }
  try {
    const result = renderKitchen(options)
    for (const file of result.written) console.error(`wrote ${file}`)
    for (const [heading, body] of Object.entries(result.blocks)) {
      console.log(`## ${heading}\n\n${body}\n`)
    }
    return 0
  } catch (error) {
    console.error(`render.js: ${error.message}`)
    return 1
  }
}

// Run only when invoked directly, so importing this module in a test runs nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
