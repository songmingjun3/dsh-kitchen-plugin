import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquire, exclusive, isLocked, LockBusy, STALE_MS } from '../lib/locks.js'

function lockPath() {
  const root = mkdtempSync(join(tmpdir(), 'dkitchen-lock-'))
  return join(root, 'guard')
}

test('a free lock is acquired and reported held', async () => {
  const path = lockPath()
  const release = await acquire(path)
  assert.equal(isLocked(path), true)
  release()
  assert.equal(isLocked(path), false)
})

test('a second non-blocking acquire is refused', async () => {
  const path = lockPath()
  const release = await acquire(path)
  try {
    await assert.rejects(() => acquire(path, { blocking: false }), LockBusy)
  } finally {
    release()
  }
})

test('a blocking acquire waits for the holder and then succeeds', async () => {
  const path = lockPath()
  const release = await acquire(path)
  setTimeout(release, 60)
  const second = await acquire(path, { blocking: true, timeoutMs: 2000 })
  assert.equal(isLocked(path), true)
  second()
})

test('a blocking acquire gives up at its timeout', async () => {
  const path = lockPath()
  const release = await acquire(path)
  try {
    await assert.rejects(
      () => acquire(path, { blocking: true, timeoutMs: 120 }),
      LockBusy,
    )
  } finally {
    release()
  }
})

test('release is idempotent', async () => {
  const path = lockPath()
  const release = await acquire(path)
  release()
  release()
  assert.equal(isLocked(path), false)
})

test('a lock abandoned by a dead holder is cleared after the stale window', async () => {
  const path = lockPath()
  const release = await acquire(path)
  // Simulate a crash: drop the directory's owner away from the current time.
  const { utimesSync } = await import('node:fs')
  const old = new Date(Date.now() - STALE_MS - 5_000)
  utimesSync(path, old, old)
  // The previous holder never releases; a new acquire must still succeed.
  const fresh = await acquire(path, { timeoutMs: 1000 })
  assert.equal(isLocked(path), true)
  fresh()
  release()
})

test('exclusive runs the body and always releases', async () => {
  const path = lockPath()
  assert.equal(await exclusive(path, () => 'value'), 'value')
  assert.equal(isLocked(path), false)

  await assert.rejects(() => exclusive(path, () => { throw new Error('boom') }), /boom/)
  assert.equal(isLocked(path), false)
})

test('a lock held elsewhere keeps others out while the body runs', async () => {
  const path = lockPath()
  await exclusive(path, async () => {
    await assert.rejects(() => acquire(path, { blocking: false }), LockBusy)
  })
})

test('a lock directory removed by hand is reacquirable', async () => {
  const path = lockPath()
  const release = await acquire(path)
  rmSync(path, { recursive: true, force: true })
  const fresh = await acquire(path)
  fresh()
  release()
})
