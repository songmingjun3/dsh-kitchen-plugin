import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The harness supplies `@deepseek-ai/dsh-tools` at runtime and a plain `node --test` cannot
// resolve it, so the registry call is replaced with an identity stand-in. What these tests
// check is what dkitchen declares, not what the harness compiles it into.
const { useDefineTool } = await import('../lib/registry-access.js')
useDefineTool((definition) => definition)

/** A ctx that records what the plugin registers, without a harness. */
function fakeCtx({ sessions = [], agents = {} } = {}) {
  const registered = []
  const effects = []
  const listeners = []
  // Sessions expose `id` and `deriveMessages()`; anything else is the caller's business.
  const live = sessions.map((session) => ({
    id: session.id,
    deriveMessages: session.deriveMessages ?? (() => []),
  }))
  return {
    registered,
    listeners,
    tools: {
      register(tool) {
        // Mirror the registry's contract: a name, a schema with an explicit
        // additionalProperties, and an execute body.
        assert.equal(typeof tool.name, 'string')
        assert.ok(tool.output && tool.output.schema)
        assert.equal(
          typeof tool.output.schema.additionalProperties, 'boolean',
          `${tool.name} must name additionalProperties explicitly`,
        )
        registered.push(tool)
      },
    },
    agents,
    sessions: {
      list: () => live,
      get: (id) => live.find((session) => session.id === id) ?? null,
    },
    // cordis event registration; the answerer is registered this way.
    on(event, listener) {
      listeners.push({ event, listener })
    },
    effect(body) {
      effects.push(body)
      return body()
    },
  }
}

/** A session id in the shape the harness uses. */
const ID = 'session-11111111-2222-3333-4444-555555555555'
const ID2 = 'session-99999999-8888-7777-6666-555555555555'

async function withRepo(toml) {
  const root = mkdtempSync(join(tmpdir(), 'dkitchen-apply-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  if (toml !== undefined) writeFileSync(join(root, '.dkitchen.toml'), toml, 'utf8')
  return root
}

test('a healthy configuration registers the session and state tools', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('[kitchen]\nstations = ["orchestrator", "executor"]\n')
  const ctx = fakeCtx()
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const names = ctx.registered.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'dkitchen_archive', 'dkitchen_board', 'dkitchen_check_refs', 'dkitchen_config',
    'dkitchen_executor_status', 'dkitchen_info', 'dkitchen_launch',
    'dkitchen_list_sessions', 'dkitchen_log', 'dkitchen_logs', 'dkitchen_merge',
    'dkitchen_new_session', 'dkitchen_read', 'dkitchen_relay', 'dkitchen_rename',
    'dkitchen_run_status', 'dkitchen_send', 'dkitchen_session_status', 'dkitchen_status',
    'dkitchen_stop', 'dkitchen_watch', 'dkitchen_watch_state',
  ])
})

test('every registered tool has a description and a callable execute', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('')
  const ctx = fakeCtx()
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  for (const tool of ctx.registered) {
    assert.ok(tool.description && tool.description.trim().length > 10, `${tool.name} needs a description`)
    assert.equal(typeof tool.execute, 'function')
  }
})

test('a broken configuration still registers the tools and reports at call time', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('[kitchen]\nstations = ["chef"]\n')
  const ctx = fakeCtx()
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const status = ctx.registered.find((tool) => tool.name === 'dkitchen_status')
  assert.ok(status, 'the status tool must still be registered')
  const result = await status.execute({ cwd: root })
  assert.equal(result.available, false)
  assert.match(result.reason, /unknown stations: chef/)
})

test('list_sessions joins the live sessions with the kitchen registry rows', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('')
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-state-'))
  const { put } = await import(`../lib/registry.js?${Math.random()}`)
  put({
    id: ID, name: 'Ablation', station: 'executor', cwd: root, created_ns: 1,
    issue: 7, repo: 'o/n', provider: 'trae', model: 'flash', effort: null, closed: false,
  })
  const ctx = fakeCtx({ sessions: [{ id: ID }, { id: ID2 }] })
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const tool = ctx.registered.find((item) => item.name === 'dkitchen_list_sessions')
  const result = await tool.execute()
  assert.equal(result.count, 2)
  const named = result.sessions.find((row) => row.session === ID)
  assert.equal(named.name, 'Ablation')
  assert.equal(named.station, 'executor')
  const unknown = result.sessions.find((row) => row.session === ID2)
  assert.equal(unknown.name, null)
})

test('board reports each row, and status text only when asked', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('')
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-board-'))
  const ctx = fakeCtx({ sessions: [{ id: ID }] })
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const tool = ctx.registered.find((item) => item.name === 'dkitchen_board')
  const plain = await tool.execute({})
  assert.equal(plain.count, 1)
  assert.equal('reply' in plain.sessions[0], false)
  const withStatus = await tool.execute({ status: true })
  assert.ok('reply' in withStatus.sessions[0])
})

test('an unknown target is refused with the candidate list', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('')
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-unknown-'))
  const ctx = fakeCtx({ sessions: [{ id: ID }] })
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const tool = ctx.registered.find((item) => item.name === 'dkitchen_read')
  await assert.rejects(() => tool.execute({ target: 'nope' }), /Found 0 sessions named 'nope'/)
})

test('renaming a session dkitchen never opened is refused', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('')
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-rename-'))
  const ctx = fakeCtx({ sessions: [{ id: ID }] })
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const tool = ctx.registered.find((item) => item.name === 'dkitchen_rename')
  await assert.rejects(
    () => tool.execute({ target: ID, name: 'x' }),
    /no record of /,
  )
})

test('new_session refuses a station this kitchen does not run', async () => {
  const { apply } = await import('../index.js')
  const root = await withRepo('[kitchen]\nstations = ["executor"]\n')
  const ctx = fakeCtx()
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, {})
  } finally {
    process.chdir(previous)
  }
  const tool = ctx.registered.find((item) => item.name === 'dkitchen_new_session')
  await assert.rejects(
    () => tool.execute({ name: 'x', message: 'hi', station: 'designer', cwd: root }),
    /designer is not one of this kitchen's stations \(executor\)/,
  )
})
