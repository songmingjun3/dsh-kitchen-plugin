/**
 * A created session must look like one the GUI would have opened.
 *
 * What makes a station usable and recognisable is decided at creation: the harness files it
 * under `meta.cwd`, composes its tools from the preset it binds, files it under the project's
 * workspace, and titles it from the first message unless something pins the title. A session
 * missing any of these still answers — it just cannot read a file, sits under "ungrouped", or
 * ends up called "厨房配置检查" — so each is guarded here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createSession } from '../lib/agents.js'

/** A context just wide enough for `createSession`, recording what the harness was asked for. */
function scanningContext(extra = {}) {
  const seen = []
  return {
    seen,
    ctx: {
      agents: {
        async create(options) {
          seen.push(options)
          return { agent: { session: { id: 'fake-session' } } }
        },
      },
      sessions: {},
      ...extra,
    },
  }
}

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

test('a session is created with its working directory in meta', async () => {
  const { seen, ctx } = scanningContext()
  await createSession(ctx, { sessionId: 'session-a', cwd: 'F:\\AutoResearch', route: ROUTE, config: {} })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].meta, { cwd: 'F:\\AutoResearch' })
  assert.equal(seen[0].sessionId, 'session-a')
})

test('the route is passed as agent options', async () => {
  const { seen, ctx } = scanningContext()
  await createSession(ctx, {
    sessionId: 'session-b',
    cwd: 'F:\\AutoResearch',
    route: { ...ROUTE, effort: 'high' },
    config: {},
  })
  assert.equal(seen[0].agentOptions.provider, 'deepseek-official')
  assert.equal(seen[0].agentOptions.model, 'deepseek-v4-flash')
  assert.equal(seen[0].agentOptions.reasoningEffort, 'high')
})

test('without a working directory no meta is sent, rather than an empty one', async () => {
  const { seen, ctx } = scanningContext()
  await createSession(ctx, { sessionId: 'session-c', cwd: '', route: ROUTE, config: {} })
  assert.equal(seen[0].meta, undefined)
})

test('the header names the preset and the setup binds it', async () => {
  const mounted = []
  const { seen, ctx } = scanningContext({
    agentPresets: {
      async mount(agentCtx, id) {
        mounted.push({ agentCtx, id })
        return { id }
      },
    },
  })
  await createSession(ctx, { sessionId: 'session-d', cwd: 'F:\\AutoResearch', route: ROUTE, config: {} })

  assert.equal(seen[0].meta.agentPreset, 'standard')
  assert.equal(typeof seen[0].setup, 'function')
  const agentCtx = { name: 'fake-agent-ctx' }
  await seen[0].setup(agentCtx)
  assert.deepEqual(mounted, [{ agentCtx, id: 'standard' }])
})

test('a created session is filed under the workspace whose path is its cwd', async () => {
  const attached = []
  const workspace = {
    path: 'F:\\AutoResearch',
    async attachSession(id) { attached.push(id) },
  }
  const { ctx } = scanningContext({
    workspaceRegistry: { list: async () => [{ path: 'F:\\dkitchen' }, workspace] },
  })
  await createSession(ctx, { sessionId: 'session-e', cwd: 'f:\\autoresearch', route: ROUTE, config: {} })
  assert.deepEqual(attached, ['session-e'])
})

test('a workspace attach failure does not stop the session from opening', async () => {
  const { ctx } = scanningContext({
    workspaceRegistry: {
      list: async () => [{ path: 'F:\\AutoResearch', attachSession: async () => { throw new Error('refused') } }],
    },
  })
  const opened = await createSession(ctx, { sessionId: 'session-f', cwd: 'F:\\AutoResearch', route: ROUTE, config: {} })
  assert.equal(opened.record.id, 'session-f')
})

test('the station name pins the harness title', async () => {
  const titled = []
  const { ctx } = scanningContext({
    sessionTitle: {
      rename(session, title) {
        titled.push({ session, title })
        return { title }
      },
    },
  })
  const opened = await createSession(ctx, {
    sessionId: 'session-g', cwd: 'F:\\AutoResearch', route: ROUTE, config: {}, name: '统筹',
  })
  assert.equal(titled.length, 1)
  assert.equal(titled[0].title, '统筹')
  assert.equal(titled[0].session, opened.handle.agent.session)
})

test('a title the harness refuses does not fail the session', async () => {
  const { ctx } = scanningContext({
    sessionTitle: { rename() { throw new Error('not live') } },
  })
  const opened = await createSession(ctx, {
    sessionId: 'session-h', cwd: 'F:\\AutoResearch', route: ROUTE, config: {}, name: '设计',
  })
  assert.equal(opened.record.id, 'session-h')
})
