/**
 * Check the `path:line` and `sha256` references in a draft comment against what they cite.
 *
 * The verifier's job is to check that every file, line, and digest a draft claims actually
 * says what it says, and this is the tool that does it. The tolerance and the "not checked"
 * distinction matter: a reference that could not be resolved is reported as unchecked rather
 * than as wrong, because the two need different fixes.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REF = /^([\w./-]+\.\w+):(\d+)(?:[-–](\d+))?$/
const SPAN = /`([^`\n]+)`/g
/** Characters allowed between a reference and the name it points at. */
const NEAR = 12
const SHA = /sha256[\s:=`]*`?([0-9a-f]{8,64})(?:…([0-9a-f]{4,64}))?/gi
const PATH = /^[\w./-]+\.\w+$/
const DEFINITION = /^\s*(?:async\s+)?(?:def|class|function|const|let)\s+(\w+)/
const IDENTIFIER = /^[A-Za-z_][\w.]{3,}$/

/**
 * Files as saved in a git revision, or as they sit under a directory.
 *
 * `ref` names a git revision; `root` reads the working tree instead. Exactly one is used, and
 * the listing is what makes a `name` resolvable: a draft says `lib/refs.js:12`, not the whole
 * path.
 */
export class Source {
  constructor(ref, root) {
    this.ref = ref
    this.root = root ?? null
    const command = this.root
      ? ['-C', String(this.root), 'ls-files']
      : ['ls-tree', '-r', '--name-only', String(ref)]
    try {
      this.names = execFileSync('git', command, { encoding: 'utf8' }).split('\n').filter((line) => line !== '')
    } catch {
      this.names = []
    }
  }

  /** The one tracked path that is `name` or ends with `/name`; null when absent or ambiguous. */
  resolve(name) {
    if (this.root) {
      const candidate = join(String(this.root), name)
      if (existsSync(candidate) && statSync(candidate).isFile()) return name
    }
    if (this.names.includes(name)) return name
    const matches = this.names.filter((entry) => entry.endsWith(`/${name}`))
    return matches.length === 1 ? matches[0] : null
  }

  read(path) {
    if (this.root) return readFileSync(join(String(this.root), path))
    return execFileSync('git', ['show', `${this.ref}:${path}`], { maxBuffer: 64 * 1024 * 1024 })
  }
}

/** Identifiers keyed by the index of the reference span they belong to. */
export function namesByReference(line, spans) {
  const isReference = (index) => index >= 0 && index < spans.length
    && REF.test(spans[index][1])
  const names = new Map()
  spans.forEach((span, index) => {
    const text = span[1]
    if (!IDENTIFIER.test(text) || PATH.test(text)) return
    const before = isReference(index - 1)
      && line.slice(spans[index - 1].end, span.start).length <= NEAR
    const after = isReference(index + 1)
      && line.slice(span.end, spans[index + 1].start).length <= NEAR
    if (!before && !after) return
    const at = before ? index - 1 : index + 1
    const list = names.get(at) ?? []
    list.push(text)
    names.set(at, list)
  })
  return names
}

/** The nearest `def` or `class` at or above the 1-based line `start`. */
export function enclosingDefinition(lines, start) {
  for (const text of lines.slice(0, start).reverse()) {
    const match = DEFINITION.exec(text)
    if (match) return match[1]
  }
  return null
}

/** Every backticked span in a line, with its offsets. */
export function spans(line) {
  const found = []
  SPAN.lastIndex = 0
  let match
  while ((match = SPAN.exec(line)) !== null) {
    found.push({ text: match[1], start: match.index, end: match.index + match[0].length, 1: match[1] })
  }
  return found
}

/**
 * Check a draft against a source.
 *
 * Returns `{findings, notes, checked}`: what is wrong, what could not be checked, and how many
 * references were examined.
 */
export function check(draft, source, tolerance = 0) {
  const findings = []
  const notes = []
  let checked = 0

  draft.split('\n').forEach((line, offset) => {
    const number = offset + 1
    const lineSpans = spans(line)
    const names = namesByReference(line, lineSpans)

    lineSpans.forEach((span, index) => {
      const match = REF.exec(span.text)
      if (!match) return
      const [, name, first, last] = match
      const path = source.resolve(name)
      if (path === null) {
        notes.push(`line ${number} \`${name}:${first}\`: no such file, or several files share `
          + 'the name; not checked')
        return
      }
      checked += 1
      const lines = source.read(path).toString('utf8').split(/\r?\n/)
      const start = Number(first)
      const end = Number(last ?? first)
      if (!(1 <= start && start <= end && end <= lines.length)) {
        findings.push(`line ${number} \`${name}:${first}\`: beyond the end of the file `
          + `(${lines.length} lines)`)
        return
      }
      const window = lines.slice(Math.max(start - 1 - tolerance, 0), end + tolerance).join('\n')
      for (const word of names.get(index) ?? []) {
        if (window.includes(word)) continue
        if (word === enclosingDefinition(lines, start)) continue
        findings.push(`line ${number} \`${name}:${first}\`: \`${word}\` is not on the cited line, `
          + `which reads ${JSON.stringify(lines[start - 1].trim().slice(0, 80))}`)
      }
    })

    SHA.lastIndex = 0
    let match
    while ((match = SHA.exec(line)) !== null) {
      const cited = lineSpans
        .filter((span) => span.end <= match.index)
        .map((span) => span.text)
        .filter((text) => PATH.test(text))
      const path = cited.length ? source.resolve(cited.at(-1)) : null
      if (path === null) {
        notes.push(`line ${number} sha256 \`${match[1]}\`: no file path found before it; not `
          + 'checked (pass a root directory for files outside git)')
        continue
      }
      checked += 1
      const digest = createHash('sha256').update(source.read(path)).digest('hex')
      const prefix = match[1].toLowerCase()
      const suffix = (match[2] ?? '').toLowerCase()
      if (!digest.startsWith(prefix) || (suffix && !digest.endsWith(suffix))) {
        findings.push(`line ${number} \`${path}\` has sha256 ${digest.slice(0, 8)}…`
          + `${digest.slice(-4)}, the draft says ${match[0]}`)
      }
    }
  })

  return { findings, notes, checked }
}
