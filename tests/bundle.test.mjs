import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BUNDLE = join(import.meta.dirname, '..')

function manifest() {
  return JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8'))
}

test('the manifest points at a patch and a client half', () => {
  const data = manifest()
  assert.equal(data.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(data.dsh.client.platform, 'web')
  assert.ok(data.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
  assert.equal(data.exports['./client'], './client.js')
})

test('the bundle declares no runtime dependencies', () => {
  const data = manifest()
  // Everything it imports is supplied by the harness as a peer.
  assert.equal(data.dependencies, undefined)
  assert.ok(data.peerDependencies['@deepseek-ai/dsh-tools'])
})

test('every shipped file has an export or a files entry', () => {
  const data = manifest()
  const files = data.files
  for (const name of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'icon.svg']) {
    const matched = files.some((pattern) => {
      if (pattern === name) return true
      const [prefix, suffix] = pattern.split('*')
      return suffix !== undefined && name.startsWith(prefix) && name.endsWith(suffix)
    })
    assert.ok(matched, `${name} is not covered by package.json files`)
  }
})

test('the patch mounts one row with a debug switch', () => {
  const text = readFileSync(join(BUNDLE, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /id: dkitchen/)
  assert.match(text, /name: dsh-dkitchen/)
  assert.match(text, /debug: false/)
  // The Python-era bundle mounted the MCP client; this one must not mount it. The comment
  // above the row explains why, so only a `name:` line counts as mounting it.
  assert.doesNotMatch(text, /name:\s*'@deepseek-ai\/dsh-mcp-client'/)
})

test('every locale defines the keys the page asks for', () => {
  const source = readFileSync(join(BUNDLE, 'client.js'), 'utf8')
  const wanted = new Set([...source.matchAll(/t\('([a-zA-Z]+)'\)/g)].map((match) => match[1]))
  assert.ok(wanted.size > 0)
  for (const language of ['en', 'zh']) {
    const dictionary = JSON.parse(readFileSync(join(BUNDLE, 'locale', `${language}.json`), 'utf8'))
    for (const key of wanted) {
      assert.ok(dictionary[key], `${language}.json is missing ${key}`)
    }
    assert.ok(dictionary.meta.title)
    assert.ok(dictionary.meta.description)
    assert.ok(dictionary.agentMessage)
  }
})

test('the agent message describes the configuration file, not an installer', () => {
  for (const language of ['en', 'zh']) {
    const dictionary = JSON.parse(readFileSync(join(BUNDLE, 'locale', `${language}.json`), 'utf8'))
    assert.match(dictionary.agentMessage, /\.dkitchen\.toml/)
    // Nothing needs installing any more, so the old instructions must be gone.
    assert.doesNotMatch(dictionary.agentMessage, /pip install|pipx|ding plugin install/)
  }
})

test('the icon is an SVG the harness accepts', () => {
  const raw = readFileSync(join(BUNDLE, 'icon.svg'))
  assert.ok(raw.length <= 256 * 1024)
  assert.ok(raw.includes('<svg'))
})

test('the README names the tools it actually registers', () => {
  const readme = readFileSync(join(BUNDLE, 'README.md'), 'utf8')
  for (const name of ['dkitchen_new_session', 'dkitchen_launch', 'dkitchen_merge',
    'dkitchen_watch', 'dkitchen_config', 'dkitchen_check_refs', 'dkitchen_status']) {
    assert.ok(readme.includes(name), `README does not mention ${name}`)
  }
})
