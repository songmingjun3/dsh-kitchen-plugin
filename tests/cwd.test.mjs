import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentCwd, resolveRoot } from '../lib/cwd.js'

test('an agent exposes its directory through session meta', () => {
  assert.equal(agentCwd({ session: { meta: { cwd: '/work/repo' } } }), '/work/repo')
})

test('an agent exposes it through its own meta', () => {
  assert.equal(agentCwd({ meta: { cwd: '/work/repo' } }), '/work/repo')
})

test('an agent with a plain cwd is read', () => {
  assert.equal(agentCwd({ cwd: '/work/repo' }), '/work/repo')
})

test('a blank or missing directory reads as unknown, never as empty', () => {
  assert.equal(agentCwd({ cwd: '   ' }), null)
  assert.equal(agentCwd({}), null)
  assert.equal(agentCwd(null), null)
  assert.equal(agentCwd(undefined), null)
})

test('an explicit root wins over the agent', () => {
  const found = resolveRoot({ explicit: '/explicit', agent: { cwd: '/agent' } })
  assert.deepEqual(found, { root: '/explicit', source: 'argument' })
})

test('the agent directory is used when no root is given', () => {
  const found = resolveRoot({ agent: { session: { meta: { cwd: '/agent' } } }, fallback: '/proc' })
  assert.deepEqual(found, { root: '/agent', source: 'agent' })
})

test('the process directory is the last resort, and says so', () => {
  const found = resolveRoot({ agent: null, fallback: '/proc' })
  assert.deepEqual(found, { root: '/proc', source: 'process' })
})
