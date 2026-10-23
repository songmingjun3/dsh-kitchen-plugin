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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSession, ensureLoaded, followup, liveHandle, resumeSession } from '../lib/agents.js'

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
  await createSession(ctx, { sessionId: 'session-e', cwd: 'F:\\AutoResearch', route: ROUTE, config: {} })
  assert.deepEqual(attached, ['session-e'])
})

test('a cwd differing only in case matches a workspace on Windows, and only there', async () => {
  // Windows paths are case-insensitive, POSIX paths are not, so the same pair must behave
  // differently on each. Asserting one answer for both is what made this suite fail on Linux.
  const attached = []
  const workspace = { path: '/srv/Repo', async attachSession(id) { attached.push(id) } }
  const { ctx } = scanningContext({
    workspaceRegistry: { list: async () => [workspace] },
  })
  await createSession(ctx, { sessionId: 'session-c', cwd: '/srv/repo', route: ROUTE, config: {} })
  assert.deepEqual(attached, process.platform === 'win32' ? ['session-c'] : [])
})

test('a trailing separator does not stop a workspace from matching', async () => {
  const attached = []
  const workspace = { path: '/srv/repo/', async attachSession(id) { attached.push(id) } }
  const { ctx } = scanningContext({ workspaceRegistry: { list: async () => [workspace] } })
  await createSession(ctx, { sessionId: 'session-t', cwd: '/srv/repo', route: ROUTE, config: {} })
  assert.deepEqual(attached, ['session-t'])
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

test('a delivered message carries its own identity', async () => {
  const sent = []
  const handle = {
    agent: {
      async followup(message) { sent.push(message) },
      async whenIdle() {},
    },
  }
  await followup(handle, 'hello', { wait: true })
  assert.equal(sent.length, 1)
  // The stored `user/message` event keeps this id; without it the session is refused as
  // corrupt the next time it is loaded.
  assert.match(sent[0].id, /^[0-9a-f-]{36}$/)
  assert.equal(sent[0].role, 'user')
  assert.deepEqual(sent[0].content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(sent[0].source, { kind: 'user' })
})

test('a worktree gets a workspace of its own instead of staying ungrouped', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'kitchen-parent-'))
  const worktree = join(parent, 'worktrees', 'route3-data-prep')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/route3-data-prep\n')

  const attached = []
  const created = []
  const { ctx } = scanningContext({
    workspaceRegistry: {
      list: async () => [{ path: parent, attachSession: async (id) => attached.push(`parent:${id}`) }],
      async create(path, title) {
        created.push({ path, title })
        return { path, attachSession: async (id) => attached.push(id) }
      },
    },
  })
  await createSession(ctx, { sessionId: 'session-w', cwd: worktree, route: ROUTE, config: {} })

  assert.deepEqual(created, [{ path: worktree, title: 'route3-data-prep' }])
  assert.deepEqual(attached, ['session-w'])
})

test('a plain subdirectory is not turned into a workspace', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'kitchen-parent-'))
  const plain = join(parent, 'outputs')
  mkdirSync(plain, { recursive: true })

  const created = []
  const { ctx } = scanningContext({
    workspaceRegistry: {
      list: async () => [{ path: parent, attachSession: async () => {} }],
      async create(path, title) { created.push({ path, title }) },
    },
  })
  await createSession(ctx, { sessionId: 'session-x', cwd: plain, route: ROUTE, config: {} })
  assert.deepEqual(created, [])
})

test('a live session the kitchen did not open still gets a handle', () => {
  const agent = { session: { id: 'session-live' } }
  assert.deepEqual(liveHandle({ agents: { get: (id) => (id === 'session-live' ? agent : undefined) } }, 'session-live'), { agent })
  assert.equal(liveHandle({ agents: { get: () => undefined } }, 'session-gone'), undefined)
  assert.equal(liveHandle({}, 'session-none'), undefined)
})

test('a session that is on disk but not loaded is resumed, not refused', async () => {
  const asked = []
  const mounted = []
  const ctx = {
    agents: {
      async resume(options) {
        asked.push(options)
        return { agent: { session: { id: options.resumeSessionId } } }
      },
    },
    agentPresets: {
      async mount(agentCtx, id) { mounted.push(id) },
    },
  }
  const handle = await resumeSession(ctx, 'session-stored', { provider: 'qoder', model: 'qfmodel', effort: 'high' })

  assert.equal(asked.length, 1)
  assert.equal(asked[0].resumeSessionId, 'session-stored')
  assert.deepEqual(asked[0].agentOptions, { provider: 'qoder', model: 'qfmodel', reasoningEffort: 'high' })
  assert.equal(typeof asked[0].setup, 'function')
  await asked[0].setup({})
  // A resumed station keeps the tools a freshly created one gets.
  assert.deepEqual(mounted, ['standard'])
  assert.equal(handle.agent.session.id, 'session-stored')
})

test('a resume the harness refuses reports no handle instead of throwing', async () => {
  const ctx = { agents: { async resume() { throw new Error('missing log') } } }
  assert.equal(await resumeSession(ctx, 'session-gone', { provider: 'qoder', model: 'qfmodel' }), undefined)
  assert.equal(await resumeSession({}, 'session-none', {}), undefined)
})

test('a reader loads the session first, and leaves a loaded one alone', async () => {
  const resumed = []
  const ctx = {
    sessions: { get: (id) => (id === 'session-loaded' ? { id } : undefined) },
    agents: {
      async resume(options) { resumed.push(options.resumeSessionId); return { agent: {} } },
    },
  }
  const record = { provider: 'qoder', model: 'qfmodel', effort: 'high', cwd: 'F:\\AutoResearch' }

  assert.equal(await ensureLoaded(ctx, 'session-loaded', record, null), true)
  assert.deepEqual(resumed, [])

  assert.equal(await ensureLoaded(ctx, 'session-stored', record, null), true)
  assert.deepEqual(resumed, ['session-stored'])
})

test('a reader with nothing to load says so rather than pretending it succeeded', async () => {
  const ctx = { sessions: { get: () => undefined } }
  assert.equal(await ensureLoaded(ctx, 'session-absent', null, null), false)
})
