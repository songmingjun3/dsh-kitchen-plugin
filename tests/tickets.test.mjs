import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  role, fields, stateAndWaiting, executorWakes, summary, isSigned, hasStatusBlock, isStale,
} from '../lib/tickets.js'

/** The shipped defaults, in the shape `config.js` produces. */
const config = {
  stations: {
    orchestrator: 'Orchestrator', designer: 'Designer', verifier: 'Verifier',
    executor: 'Executor', user: 'User', separator: ': ',
  },
  status: {
    fields: ['Status', 'Waiting on', 'Key numbers', 'Next'],
    in_progress: 'in progress', waiting_on_design: 'waiting on design',
    blocked: 'blocked', done: 'done', none: 'none',
  },
  sessionPatterns: () => ['DSH session', 'Codex session'],
}

test('a comment opening with a station name has that role', () => {
  assert.equal(role('Designer: here is the ticket\nStatus: done', config), 'Designer')
  assert.equal(role('## Orchestrator: dispatched', config), 'Orchestrator')
})

test('a comment signed with a session line is the executor', () => {
  assert.equal(role('Status: done\nDSH session: abc-123', config), 'Executor')
})

test('the pre-migration signature still reads as an executor', () => {
  assert.equal(role('Codex session: abc-123', config), 'Executor')
})

test('an unsigned comment is the user', () => {
  assert.equal(role('just a note from me', config), 'User')
})

test('a signature quoted inside a line does not sign it', () => {
  assert.equal(role('see the note DSH session: abc', config), 'User')
})

test('status fields accept both colon widths', () => {
  assert.deepEqual(fields('Status: blocked\nWaiting on：Executor', config), {
    Status: 'blocked', 'Waiting on': 'Executor',
  })
})

test('state and waiting come from the first two fields', () => {
  assert.deepEqual(stateAndWaiting('Status: done\nWaiting on: Orchestrator', config),
    ['done', 'Orchestrator'])
})

test('an executor still in progress does not wake the orchestrator', () => {
  assert.equal(executorWakes('Status: in progress\nWaiting on: none', false, config), false)
})

test('an executor that finished wakes it', () => {
  assert.equal(executorWakes('Status: done\nWaiting on: none', false, config), true)
})

test('an executor waiting on the orchestrator wakes it', () => {
  assert.equal(executorWakes('Status: in progress\nWaiting on: Orchestrator', false, config), true)
})

test('on an awaiting-user ticket only a blocked or done executor wakes it', () => {
  assert.equal(executorWakes('Status: in progress\nWaiting on: none', true, config), false)
  assert.equal(executorWakes('Status: blocked\nWaiting on: User', true, config), true)
  assert.equal(executorWakes('Status: done\nWaiting on: none', true, config), true)
})

test('a Waiting on of "none" names nobody', () => {
  assert.equal(executorWakes('Status: in progress\nWaiting on: none User', false, config), false)
})

test('the summary prefers the status block over prose', () => {
  assert.equal(
    summary('Status: blocked\nWaiting on: User\nKey numbers: 3 runs\nNext: ask\n\nextra prose', config),
    'Status: blocked; Waiting on: User',
  )
})

test('a comment with no status block summarises its first line', () => {
  assert.equal(summary('a plain note\nsecond line', config), 'a plain note')
})

test('a signed comment is recognised under either spelling', () => {
  assert.equal(isSigned('DSH session: x', config), true)
  assert.equal(isSigned('Codex session: x', config), true)
  assert.equal(isSigned('nothing here', config), false)
})

test('a status block is what makes a comment a report', () => {
  assert.equal(hasStatusBlock('Status: done', config), true)
  assert.equal(hasStatusBlock('a note', config), false)
})

test('a stale report is in progress and older than the cutoff', () => {
  const cutoff = '2026-10-22T00:00:00Z'
  assert.equal(isStale('Status: in progress', '2026-10-21T00:00:00Z', cutoff, config), true)
  assert.equal(isStale('Status: in progress', '2026-10-22T06:00:00Z', cutoff, config), false)
  assert.equal(isStale('Status: done', '2026-10-21T00:00:00Z', cutoff, config), false)
  assert.equal(isStale('a note', '2026-10-21T00:00:00Z', cutoff, config), false)
})
