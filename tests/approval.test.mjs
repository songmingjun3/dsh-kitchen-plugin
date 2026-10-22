import { test } from 'node:test'
import assert from 'node:assert/strict'

import { approvalPolicy, matchesAny } from '../lib/approval.js'

test('a configuration with no approval table answers nothing', () => {
  assert.deepEqual(approvalPolicy({}), { allow: [], reject: [] })
  assert.deepEqual(approvalPolicy(null), { allow: [], reject: [] })
})

test('the policy lists are read from the configuration', () => {
  const config = { approval: { allow: ['dkitchen_*'], reject: ['bash'] } }
  assert.deepEqual(approvalPolicy(config), {
    allow: ['dkitchen_*'], reject: ['bash'],
  })
})

test('a non-array policy value reads as empty rather than as a wildcard', () => {
  assert.deepEqual(approvalPolicy({ approval: { allow: 'dkitchen_*' } }), {
    allow: [], reject: [],
  })
})

test('a prefix entry matches a whole plugin', () => {
  assert.equal(matchesAny('dkitchen_read', ['dkitchen_*']), true)
  assert.equal(matchesAny('dkitchen_status', ['dkitchen_*']), true)
})

test('a prefix entry does not match another plugin', () => {
  assert.equal(matchesAny('bash', ['dkitchen_*']), false)
  assert.equal(matchesAny('dkitchenx', ['dkitchen_*']), false)
})

test('an exact entry matches only itself', () => {
  assert.equal(matchesAny('read', ['read']), true)
  assert.equal(matchesAny('read_file', ['read']), false)
})

test('an empty policy matches nothing', () => {
  assert.equal(matchesAny('anything', []), false)
})
