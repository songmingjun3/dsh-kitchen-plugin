/**
 * The orchestrator's routine GitHub writes.
 *
 * Every log entry, relay and merge goes through `orchestrate`, and each of them formats text
 * from the repository's own vocabulary. `logBody` reached for a function on the wrong object
 * and threw for every entry ever written; nothing called it in a test, so nothing said so.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load, FILE } from '../lib/config.js'
import { logBody, signed, ticketReferences } from '../lib/orchestrate.js'

/** A throwaway repository with an optional `.dkitchen.toml`. */
function repo(toml) {
  const root = mkdtempSync(join(tmpdir(), 'dkitchen-orch-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  if (toml !== undefined) writeFileSync(join(root, FILE), toml, 'utf8')
  return root
}

const CHINESE = [
  '[stations]',
  'orchestrator = "统筹"',
  'designer = "设计"',
  'verifier = "校验"',
  'executor = "执行"',
  'separator = "："',
  '',
  '[status]',
  'none = "无"',
  '',
  '[log]',
  'pending = "等待用户"',
  '',
].join('\n')

test('a log entry is signed with the orchestrator signature and stamped in UTC', () => {
  const config = load(repo(CHINESE), { root: undefined })
  const moment = new Date('2026-10-23T04:05:00Z')
  const body = logBody(['#3 已完成数据准备'], ['#4 需要选择数据集'], moment, config)

  const lines = body.split('\n')
  assert.equal(lines[0], '统筹：04:05 UTC')
  assert.equal(lines[1], '- #3 已完成数据准备')
  assert.equal(lines[2], '- 等待用户： #4 需要选择数据集'.replace('： ', '：'))
})

test('an entry with nothing pending says so in the configured word', () => {
  const config = load(repo(CHINESE), { root: undefined })
  const body = logBody(['#3 已完成'], [], new Date('2026-10-23T00:00:00Z'), config)
  assert.match(body, /等待用户：无$/)
})

test('the English defaults produce an English entry', () => {
  const config = load(repo(), { root: undefined })
  const body = logBody(['did a thing'], [], new Date('2026-10-23T13:45:00Z'), config)
  assert.equal(body.split('\n')[0], 'Orchestrator: 13:45 UTC')
  assert.match(body, /Waiting for the user: none$/)
})

test('a relay is signed once, not twice', () => {
  const config = load(repo(CHINESE), { root: undefined })
  assert.equal(signed('#3 已派给执行', config), '统筹：#3 已派给执行')
  assert.equal(signed('统筹：#3 已派给执行', config), '统筹：#3 已派给执行')
})

test('ticket references are read from a PR body', () => {
  const body = 'Closes #3 and https://github.com/songmingjun3/AutoResearch/issues/7, not #9 or x#12'
  assert.deepEqual(ticketReferences(body, 'songmingjun3/AutoResearch', 9), [3, 7])
})
