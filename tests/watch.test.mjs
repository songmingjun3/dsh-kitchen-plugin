import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let watch

beforeEach(async () => {
  process.env.DKITCHEN_STATE_HOME = mkdtempSync(join(tmpdir(), 'dkitchen-watch-'))
  watch = await import(`../lib/watch.js?${Math.random()}`)
})

function writeRuns(records) {
  const dir = join(process.env.DKITCHEN_STATE_HOME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runs.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function appendRuns(records) {
  const dir = join(process.env.DKITCHEN_STATE_HOME)
  appendFileSync(join(dir, 'runs.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

test('a state path is per repository', () => {
  const one = watch.defaultStatePath('owner/one')
  const two = watch.defaultStatePath('owner/two')
  assert.notEqual(one, two)
  assert.match(one, /owner-one\.json$/)
})

test('no record file means nothing is busy', () => {
  assert.deepEqual([...watch.busyTickets()], [])
})

test('a started run with no stop is busy', () => {
  writeRuns([{ event: 'run_start', run_id: 'r1', name: 'eval #42', cwd: '/repo' }])
  assert.deepEqual([...watch.busyTickets()], [42])
})

test('a stopped run is no longer busy', () => {
  writeRuns([
    { event: 'run_start', run_id: 'r1', name: 'eval #42' },
    { event: 'run_stop', run_id: 'r1' },
  ])
  assert.deepEqual([...watch.busyTickets()], [])
})

test('a task exit settles a run too', () => {
  writeRuns([
    { event: 'run_start', run_id: 'r1', name: 'eval #7' },
    { event: 'task_exit', run_id: 'r1', exit_code: 0 },
  ])
  assert.deepEqual([...watch.busyTickets()], [])
})

test('only the last record per run decides', () => {
  writeRuns([
    { event: 'run_start', run_id: 'r1', name: 'a #1' },
    { event: 'run_start', run_id: 'r2', name: 'b #2' },
    { event: 'run_stop', run_id: 'r1' },
  ])
  assert.deepEqual([...watch.busyTickets()], [2])
})

test('an issue named in the job name or the working directory both count', () => {
  writeRuns([
    { event: 'run_start', run_id: 'r1', name: 'job #5' },
    { event: 'run_start', run_id: 'r2', name: 'plain', cwd: '/work/issue-9' },
  ])
  assert.deepEqual([...watch.busyTickets()].sort((a, b) => a - b), [5, 9])
})

test('a broken record line is skipped, not fatal', () => {
  const dir = join(process.env.DKITCHEN_STATE_HOME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runs.jsonl'), 'not json\n{"event":"run_start","run_id":"r","name":"x #3"}\n')
  assert.deepEqual([...watch.busyTickets()], [3])
})

test('appending a later stop clears a run that was busy', () => {
  writeRuns([{ event: 'run_start', run_id: 'r1', name: 'x #8' }])
  assert.deepEqual([...watch.busyTickets()], [8])
  appendRuns([{ event: 'run_stop', run_id: 'r1' }])
  assert.deepEqual([...watch.busyTickets()], [])
})
