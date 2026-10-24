/**
 * The station defaults a user edits in Settings, and the precedence they obey.
 *
 * The point of the feature is a route a person sets once and every later session picks up, so
 * what matters here is not that a string round-trips but that the repository stays in control:
 * a `.dkitchen.toml` that names its own route must win, and a blank field must not become a
 * route to nowhere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STATIONS, defaultRoute, defaults, fieldFor } from '../lib/station-defaults.js'
import { applyStationDefaults, stationDefaultReport } from '../index.js'

/**
 * A resolved configuration shaped like `load()` returns, with overrides applied.
 *
 * `declared` records which sections the file actually wrote: `withHelpers` fills `harness` with
 * defaults, so a resolved object can never answer "did the repository choose a route?" on its
 * own.
 */
function settings({ models = {}, harness = {}, declared } = {}) {
  return {
    root: '/repo',
    models: { stations: models },
    harness: { default_provider: 'base-provider', default_model: 'base-model', ...harness },
    declared: { harness: false, models: false, ...declared },
  }
}

test('every station has a field, and the field name is derived from it', () => {
  assert.deepEqual(STATIONS, ['orchestrator', 'designer', 'verifier', 'executor'])
  assert.equal(fieldFor('executor'), 'executorModel')
  assert.equal(fieldFor('verifier'), 'verifierModel')
})

test('provider/model names both halves of the route', () => {
  assert.deepEqual(defaultRoute({ executorModel: 'trae/deepseek-v4' }, 'executor'),
    { provider: 'trae', model: 'deepseek-v4' })
})

test('a bare model id keeps the provider, which is the common case', () => {
  // "Run the verifier on something cheaper" usually changes only the model.
  assert.deepEqual(defaultRoute({ verifierModel: 'claude-sonnet-5' }, 'verifier'),
    { provider: null, model: 'claude-sonnet-5' })
})

test('a blank or missing field is no default at all', () => {
  assert.equal(defaultRoute({ executorModel: '' }, 'executor'), null)
  assert.equal(defaultRoute({ executorModel: '   ' }, 'executor'), null)
  assert.equal(defaultRoute({}, 'executor'), null)
  assert.equal(defaultRoute(null, 'executor'), null)
})

test('a live reference is dereferenced, because that is what the harness hands a plugin', () => {
  // A `volatile()` field validates to a reference (`{get()}`), not to a string. Missing this
  // made every station default look unset through the real schema, while the unit tests — which
  // pass plain strings — kept passing.
  const ref = (value) => ({ get: () => value })
  assert.deepEqual(defaultRoute({ executorModel: ref('trae/v4') }, 'executor'),
    { provider: 'trae', model: 'v4' })
  assert.deepEqual(defaultRoute({ verifierModel: ref('cheap') }, 'verifier'),
    { provider: null, model: 'cheap' })
  assert.equal(defaultRoute({ executorModel: ref('') }, 'executor'), null)
})

test('a trailing slash is a bare id, not an empty model', () => {
  // `trae/` has a separator but no model; treating it as a route would send a session to a
  // provider with no model rather than falling through to the repository's own choice.
  assert.deepEqual(defaultRoute({ executorModel: 'trae/' }, 'executor'),
    { provider: null, model: 'trae/' })
})

test('defaults reports only the stations that have one', () => {
  const found = defaults({ orchestratorModel: 'a/b', executorModel: '', verifierModel: 'c' })
  assert.deepEqual(Object.keys(found).sort(), ['orchestrator', 'verifier'])
  assert.deepEqual(found.orchestrator, { provider: 'a', model: 'b' })
})

test('an unconfigured station inherits the bundle default', () => {
  const config = settings()
  applyStationDefaults(config, { executorModel: 'trae/deepseek-v4' })
  assert.deepEqual(config.models.stations.executor, { provider: 'trae', model: 'deepseek-v4' })
})

test('a repository that names its own route keeps it', () => {
  // The whole point: the bundle default is a starting point, not an override.
  const config = settings({ models: { executor: { provider: 'mine', model: 'mine-v1' } } })
  applyStationDefaults(config, { executorModel: 'trae/deepseek-v4' })
  assert.deepEqual(config.models.stations.executor, { provider: 'mine', model: 'mine-v1' })
})

test('a repository that chose a harness route keeps all of it', () => {
  // `[harness] default_provider`/`default_model` is the repository answering the same question
  // the bundle default exists to answer, so nothing inherits past it.
  const config = settings({
    harness: { default_provider: 'repo-provider', default_model: 'repo-model' },
    declared: { harness: true },
  })
  applyStationDefaults(config, { executorModel: 'trae/deepseek-v4', verifierModel: 'cheap' })
  assert.deepEqual(config.models.stations, {})
})

test('an empty station table is treated as unset', () => {
  const config = settings({ models: { verifier: {} } })
  applyStationDefaults(config, { verifierModel: 'cheap' })
  assert.deepEqual(config.models.stations.verifier, { model: 'cheap' })
})

test('a bare default records only the model, so the provider still comes from the harness', () => {
  const config = settings()
  applyStationDefaults(config, { verifierModel: 'cheap' })
  assert.deepEqual(config.models.stations.verifier, { model: 'cheap' })
})

test('applying defaults does not disturb a station it has no default for', () => {
  const config = settings()
  applyStationDefaults(config, { executorModel: 'trae/x' })
  assert.equal(config.models.stations.orchestrator, undefined)
  assert.equal(config.models.stations.designer, undefined)
})

test('a missing station-defaults object is not an error', () => {
  const config = settings()
  applyStationDefaults(config, undefined)
  assert.deepEqual(config.models.stations, {})
})

test('the report reads a live reference as well as a plain value', () => {
  // Settings hands the plugin volatile references, read per call; a test or a pinned profile
  // hands plain values. Both must work, because the same code runs in both.
  const live = { executorModel: { get: () => 'trae/v4' } }
  assert.deepEqual(stationDefaultReport(live),
    { executor: { provider: 'trae', model: 'v4' } })

  const plain = { executorModel: 'trae/v4' }
  assert.deepEqual(stationDefaultReport(plain),
    { executor: { provider: 'trae', model: 'v4' } })
})

test('the report omits stations without a default', () => {
  assert.deepEqual(stationDefaultReport({ executorModel: '' }), {})
})
