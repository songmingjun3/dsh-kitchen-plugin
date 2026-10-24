/**
 * End to end: a station default set in Settings reaches the next session's route.
 *
 * The unit tests in `station-defaults.test.mjs` cover the precedence rules in isolation. This
 * one mounts the plugin the way the harness does and drives the real tool, because the promise
 * the feature makes is about what `dkitchen_new_session` sends to `ctx.agents.create` — not
 * about what a helper function returns.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { useDefineTool } = await import('../lib/registry-access.js')
useDefineTool((definition) => definition)

/** A ctx that records registrations and the session the plugin asks the harness to create. */
function fakeCtx() {
  const registered = []
  const created = []
  return {
    registered,
    created,
    tools: {
      register(tool) {
        assert.equal(typeof tool.name, 'string')
        registered.push(tool)
      },
    },
    agents: {
      async create(options) {
        created.push(options)
        return {
          agent: {
            session: { id: options.sessionId, meta: { id: options.sessionId } },
            async followup() {},
            async whenIdle() {},
            isIdle: () => true,
          },
        }
      },
    },
    sessions: { list: () => [], get: () => undefined },
    workspaceRegistry: { list: async () => [] },
    sessionTitle: { rename() {} },
    effect(fn) { fn() },
    on() {},
    get() { return undefined },
  }
}

/** A throwaway repository with an optional `.dkitchen.toml`. */
function withRepo(toml) {
  const root = mkdtempSync(join(tmpdir(), 'dkitchen-defaults-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  if (toml !== undefined) writeFileSync(join(root, '.dkitchen.toml'), toml, 'utf8')
  return root
}

/** Mount `apply` with the given plugin options, from inside `root`. */
async function mount(root, options) {
  const { apply } = await import('../index.js')
  const ctx = fakeCtx()
  const previous = process.cwd()
  process.chdir(root)
  try {
    apply(ctx, options)
  } finally {
    process.chdir(previous)
  }
  return ctx
}

/** Call one registered tool by name, the way the model would. */
function tool(ctx, name) {
  const found = ctx.registered.find((entry) => entry.name === name)
  assert.ok(found, `${name} was not registered`)
  return found
}

const EXEC = { agent: { session: { id: 'session-caller', meta: { id: 'session-caller' } } } }

test('a changed station default is the route the next session is created on', async () => {
  const root = withRepo('[kitchen]\nstations = ["orchestrator", "executor"]\n')
  const ctx = await mount(root, {
    // What Settings hands the plugin: live references, read per call.
    executorModel: { get: () => 'trae/deepseek-v4' },
  })
  await tool(ctx, 'dkitchen_new_session').execute({
    name: 'Ablation', message: 'go', station: 'executor', cwd: root,
  }, EXEC)

  assert.equal(ctx.created.length, 1)
  assert.deepEqual(ctx.created[0].agentOptions, {
    provider: 'trae',
    model: 'deepseek-v4',
  })
})

test('a changed default applies without remounting the plugin', async () => {
  // Settings writes while the process runs, so the next call must see the new value rather
  // than the one `apply` received.
  const root = withRepo('[kitchen]\nstations = ["executor"]\n')
  let current = ''
  const ctx = await mount(root, { executorModel: { get: () => current } })

  await tool(ctx, 'dkitchen_new_session').execute({
    name: 'one', message: 'go', station: 'executor', cwd: root,
  }, EXEC)
  current = 'trae/deepseek-v4'
  await tool(ctx, 'dkitchen_new_session').execute({
    name: 'two', message: 'go', station: 'executor', cwd: root,
  }, EXEC)

  const [first, second] = ctx.created.map((entry) => entry.agentOptions)
  assert.equal(first.model, 'deepseek-v4-flash', 'the unsets default is the harness fallback')
  assert.equal(second.model, 'deepseek-v4')
  assert.equal(second.provider, 'trae')
})

test('a repository route beats the station default', async () => {
  const root = withRepo(
    '[kitchen]\nstations = ["executor"]\n\n[models.executor]\nprovider = "mine"\nmodel = "mine-v1"\n',
  )
  const ctx = await mount(root, { executorModel: { get: () => 'trae/deepseek-v4' } })
  await tool(ctx, 'dkitchen_new_session').execute({
    name: 'Ablation', message: 'go', station: 'executor', cwd: root,
  }, EXEC)
  assert.deepEqual(ctx.created[0].agentOptions, { provider: 'mine', model: 'mine-v1' })
})

test('a per-call provider and model still win over everything', async () => {
  const root = withRepo('[kitchen]\nstations = ["executor"]\n')
  const ctx = await mount(root, { executorModel: { get: () => 'trae/deepseek-v4' } })
  await tool(ctx, 'dkitchen_new_session').execute({
    name: 'Ablation', message: 'go', station: 'executor', cwd: root,
    provider: 'once', model: 'once-only',
  }, EXEC)
  assert.deepEqual(ctx.created[0].agentOptions, { provider: 'once', model: 'once-only' })
})

test('a blank default leaves the repository settings untouched', async () => {
  const root = withRepo('[harness]\ndefault_provider = "trae"\ndefault_model = "v4"\n[kitchen]\nstations = ["executor"]\n')
  const ctx = await mount(root, { executorModel: { get: () => '' } })
  await tool(ctx, 'dkitchen_new_session').execute({
    name: 'Ablation', message: 'go', station: 'executor', cwd: root,
  }, EXEC)
  assert.deepEqual(ctx.created[0].agentOptions, { provider: 'trae', model: 'v4' })
})
