/**
 * A narrow TOML reader for `.dkitchen.toml`.
 *
 * Node has no built-in TOML parser and the Harness ships none, so the alternative would be a
 * runtime dependency in a package that is otherwise pure. `.dkitchen.toml` uses a small
 * subset: table headers, dotted table headers, strings, string arrays, integers, booleans,
 * and comments. This reads exactly that and refuses everything else with a line number,
 * because a kitchen whose config was half-understood would behave in ways the user cannot
 * see from the file.
 *
 * Deliberately unsupported, and refused rather than guessed: inline tables, multi-line
 * strings, dates, floats, arrays of tables, dotted keys on the left of `=`.
 */

export class TomlError extends Error {
  constructor(line, message) {
    super(`.dkitchen.toml:${line}: ${message}`)
    this.name = 'TomlError'
    this.line = line
  }
}

/** The value of a bare key, or a quoted key, at `text[i]`. Returns [key, nextIndex]. */
function readKey(text, i, line) {
  if (text[i] === '"' || text[i] === "'") {
    const [value, next] = readString(text, i, line)
    return [value, next]
  }
  let j = i
  while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) j++
  if (j === i) throw new TomlError(line, 'expected a key')
  return [text.slice(i, j), j]
}

/** Read a quoted string starting at `i`. Returns [value, nextIndex]. */
function readString(text, i, line) {
  const quote = text[i]
  if (text.startsWith(quote.repeat(3), i)) {
    throw new TomlError(line, 'multi-line strings are not supported')
  }
  let out = ''
  let j = i + 1
  while (j < text.length) {
    const char = text[j]
    if (char === quote) return [out, j + 1]
    if (char === '\\' && quote === '"') {
      const next = text[j + 1]
      const simple = {
        '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f',
      }
      if (next in simple) {
        out += simple[next]
        j += 2
        continue
      }
      if (next === 'u' || next === 'U') {
        const width = next === 'u' ? 4 : 8
        const hex = text.slice(j + 2, j + 2 + width)
        if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) {
          throw new TomlError(line, `invalid \\${next} escape`)
        }
        out += String.fromCodePoint(parseInt(hex, 16))
        j += 2 + width
        continue
      }
      throw new TomlError(line, `unsupported escape \\${next}`)
    }
    // A literal string ('...') has no escapes: the backslash is an ordinary character.
    out += char
    j++
  }
  throw new TomlError(line, 'unterminated string')
}

/** Read a value starting at `i`, which is already past the leading whitespace. */
function readValue(text, i, line) {
  const char = text[i]
  if (char === '"' || char === "'") {
    const [value, next] = readString(text, i, line)
    return [value, next]
  }
  if (char === '[') {
    return readArray(text, i, line)
  }
  let j = i
  while (j < text.length && !/[,}\]\s#]/.test(text[j])) j++
  const token = text.slice(i, j)
  if (token === '') throw new TomlError(line, 'expected a value')
  if (token === 'true') return [true, j]
  if (token === 'false') return [false, j]
  if (/^[+-]?\d+$/.test(token)) return [Number(token), j]
  if (/^[+-]?(\d+\.\d+|\.\d+)/.test(token)) {
    throw new TomlError(line, 'floats are not supported; use an integer')
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(token)) {
    throw new TomlError(line, 'dates are not supported')
  }
  throw new TomlError(line, `unsupported value ${JSON.stringify(token)}`)
}

/** Read `[a, b]`, including an optional trailing comma and newlines. */
function readArray(text, i, line) {
  const items = []
  let j = i + 1
  let currentLine = line
  for (;;) {
    while (j < text.length && /[\s]/.test(text[j])) {
      if (text[j] === '\n') currentLine++
      j++
    }
    if (j >= text.length) throw new TomlError(line, 'unterminated array')
    if (text[j] === ']') return [items, j + 1]
    const [value, next] = readValue(text, j, currentLine)
    items.push(value)
    j = next
    while (j < text.length && /[\s]/.test(text[j])) {
      if (text[j] === '\n') currentLine++
      j++
    }
    if (text[j] === ',') {
      j++
      continue
    }
    if (text[j] === ']') return [items, j + 1]
    throw new TomlError(currentLine, 'expected , or ] in array')
  }
}

/**
 * Split the document into statements, tracking the line each starts on.
 *
 * A statement ends at a newline, except inside an array: `fields = [` may open a list whose
 * items each sit on their own line, and TOML allows that. Comments and the strings that
 * contain `#` are handled here so the statement reader never sees either.
 */
function statements(text) {
  const out = []
  let current = ''
  let line = 1
  let startLine = 1
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      current += char
      if (char === '\\' && quote === '"') {
        current += text[i + 1] ?? ''
        i++
      } else if (char === quote) {
        quote = null
      }
      if (char === '\n') line++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '#') {
      // Skip to the end of the line; the newline itself is handled below.
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
      continue
    }
    if (char === '[') depth++
    if (char === ']') depth = Math.max(0, depth - 1)
    if (char === '\n') {
      if (depth === 0) {
        const trimmed = current.trim()
        if (trimmed !== '') out.push({ text: trimmed, line: startLine })
        current = ''
        line++
        startLine = line
      } else {
        current += ' '
        line++
      }
      continue
    }
    if (current === '') startLine = line
    current += char
  }
  const trimmed = current.trim()
  if (trimmed !== '') out.push({ text: trimmed, line: startLine })
  return out
}

/**
 * Parse `text` into a plain object of nested tables.
 *
 * Throws `TomlError` for anything outside the supported subset, naming the line.
 */
export function parseToml(text) {
  const root = {}
  let table = root
  for (const { text: line, line: lineNumber } of statements(text)) {
    if (line.startsWith('[')) {
      if (line.startsWith('[[')) {
        throw new TomlError(lineNumber, 'arrays of tables are not supported')
      }
      if (!line.endsWith(']')) {
        throw new TomlError(lineNumber, 'unterminated table header')
      }
      const inner = line.slice(1, -1).trim()
      const parts = []
      let i = 0
      while (i < inner.length) {
        while (i < inner.length && /\s/.test(inner[i])) i++
        if (i >= inner.length) break
        const [key, next] = readKey(inner, i, lineNumber)
        parts.push(key)
        i = next
        while (i < inner.length && /\s/.test(inner[i])) i++
        if (i < inner.length) {
          if (inner[i] !== '.') throw new TomlError(lineNumber, "expected '.' in table header")
          i++
        }
      }
      if (parts.length === 0) throw new TomlError(lineNumber, 'empty table header')
      table = root
      for (const part of parts) {
        const existing = table[part]
        if (existing === undefined) {
          table[part] = {}
        } else if (typeof existing !== 'object' || Array.isArray(existing)) {
          throw new TomlError(lineNumber, `${part} is already a value, not a table`)
        }
        table = table[part]
      }
      continue
    }

    const equals = line.indexOf('=')
    if (equals < 0) throw new TomlError(lineNumber, "expected 'key = value'")
    const keyText = line.slice(0, equals).trim()
    if (keyText === '') throw new TomlError(lineNumber, 'empty key')
    if (keyText.includes('.')) {
      throw new TomlError(lineNumber, "dotted keys are not supported; use a table header")
    }
    const [key] = readKey(keyText, 0, lineNumber)
    const rest = line.slice(equals + 1).trim()
    const [value, next] = readValue(rest, 0, lineNumber)
    if (rest.slice(next).trim() !== '') {
      throw new TomlError(lineNumber, 'unexpected text after the value')
    }
    if (Object.hasOwn(table, key)) {
      throw new TomlError(lineNumber, `${key} is already defined`)
    }
    table[key] = value
  }
  return root
}
