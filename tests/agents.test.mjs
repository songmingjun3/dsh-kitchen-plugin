/**
 * A created session must look like one the GUI would have opened.
 *
 * Two facts decide whether a station can work: the harness files a session under `meta.cwd`
 * and composes its file and shell tools from the preset it binds. A session missing either
 * still answers — it just reports that it cannot read a file, or appears under "ungrouped" —
 * so both are guarded here rather than discovered by a station mid-ticket.
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
          return { agent: {} }
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
