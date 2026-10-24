/**
 * dkitchen as a DeepSeek Harness plugin.
 *
 * A plugin lives where the agents do, so `ctx.agents` creates a session, `ctx.sessions` reads
 * the reply back, and `ctx.tools` carries the tools. Installing the bundle is then the whole
 * installation: no package to install, no second profile, no process to keep alive.
 *
 * One consequence of that move shapes everything here. A profile plugin is composed once, for
 * the whole process, but a kitchen belongs to a repository — and the harness serves many
 * repositories from that process. So the configuration is resolved **per call**, from the
 * session's own working directory, never once at mount time.
 *
 * Registration failures are silent: a schema the registry refuses, or a service that is not
 * mounted, leaves the process running with no tool and no error. `debug` is how that becomes
 * visible, and every step below reports through it.
 */

import { defineTool } from './lib/registry-access.js'
import { ConfigError, load } from './lib/config.js'
import { STATIONS as DEFAULT_STATIONS, defaultRoute, fieldFor } from './lib/station-defaults.js'
import { Config } from './lib/options.js'
import { resolveRoot } from './lib/cwd.js'
import { registerSessionTools } from './lib/tools.js'
import { registerStateTools } from './lib/state-tools.js'
import { registerJobTools } from './lib/job-tools.js'
import { registerTicketTools } from './lib/ticket-tools.js'
import { registerWatchTool } from './lib/watch-tools.js'
import { registerApprovalAnswerer } from './lib/approval.js'
import { registerConfigTools } from './lib/config-tools.js'
import { ensureSkill, installedSkill } from './lib/skill.js'
import { attachToWorkspace } from './lib/agents.js'
import * as registry from './lib/registry.js'

export const name = 'dkitchen'

/**
 * The bundle's own configuration, re-exported so the Loader finds it on the plugin module.
 *
 * The schema itself is in `lib/options.js`; the four `*Model` fields are the per-station
 * defaults Settings renders as a form, and changing one applies to the next session opened.
 */
export { Config }

/**
 * Services this plugin needs.
 *
 * Every one of them is required, not awaited. Cordis refuses to read a service this array does
 * not name — `cannot get property "workingDirectory" without inject` — and each of these is
 * load-bearing: without `workingDirectory` a tool configures the wrong repository, without
 * `approval` it cannot answer a policy, and without `jobs` a launch has nothing to register
 * with. A profile missing one leaves the plugin inactive, which the harness reports, rather
 * than running half a kitchen that fails in ways the user cannot see.
 */
export const inject = [
  'tools', 'agents', 'sessions', 'workingDirectory', 'jobs', 'subprocess', 'approval',
  // A session opened outside the GUI's own start-a-session path still has to look like one:
  // `agentPresets` composes the tools it runs with, and `workspaceRegistry` files it under
  // the project whose path is its cwd. Without them a station reports that it cannot read a
  // file and appears under "ungrouped" while it works.
  'agentPresets', 'workspaceRegistry',
  // The window's title comes from the harness, generated from the first message unless it is
  // pinned; a station is named for its role, not for the first thing it happened to say.
  'sessionTitle',
  // `[permissions]` opens a station's sessions under a configured preset; the service is the
  // same one `/permission` writes through, so the choice lands in the session's own record.
  'permissionPresets',
]

/**
 * Mount the kitchen.
 *
 * `config` is the row's configuration from `cordis.patch.yml`; `debug` there turns on the
 * registration trace. `config.root` optionally pins the repository, for a profile that serves
 * exactly one; without it each call resolves its own.
 *
 * The station defaults are read through the live Config references — `config.executorModel.get()`
 * rather than the value `apply` received — because Settings changes them while the process
 * runs, and a session must pick up the new route without a restart.
 */
export function apply(ctx, config = {}) {
  const debug = config.debug === true || (config.debug && config.debug.get?.() === true)
  const report = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  /**
   * The station defaults as they stand right now, keyed the way `applyStationDefaults` reads
   * them (`executorModel`, not `executor` — the option name, not the station name).
   *
   * A volatile field is a reference, so it is read per call; a plain field (a test double, or a
   * profile that pinned the value) is read as a value. Both are supported because the plugin is
   * mounted with either depending on whether Settings is in the composition.
   */
  const currentDefaults = () => {
    const live = {}
    for (const station of DEFAULT_STATIONS) {
      const name = fieldFor(station)
      const field = config[name]
      live[name] = typeof field?.get === 'function' ? field.get() : field
    }
    return live
  }

  // Resolved per call, because a process serves many repositories. A failure is returned to
  // the caller as a configuration error rather than thrown at mount time: one repository with
  // a broken `.dkitchen.toml` must not remove the tools from every other one.
  const resolveConfig = (cwd) => {
    const root = config.root ?? cwd ?? process.cwd()
    try {
      const settings = load(root, { root })
      applyStationDefaults(settings, currentDefaults())
      report('repository:', settings.root, '| stations:', settings.kitchen.stations.join(', '))
      return settings
    } catch (error) {
      if (error instanceof ConfigError) {
        report('cannot read .dkitchen.toml in', root, ':', error.message)
      }
      throw error
    }
  }

  // The setup skill goes to the machine-wide root, so `/setup-dkitchen` exists in every
  // project without a per-repository copy. A failure here must not stop the tools: a kitchen
  // that cannot install a skill is still a working kitchen, and the note says what happened.
  ctx.effect(() => {
    const outcome = ensureSkill({ debug })
    if (!outcome.installed && outcome.reason && outcome.reason !== 'already current') {
      report('setup skill not installed:', outcome.reason)
    }
    return () => {}
  })

  ctx.effect(() => {
    registerSessionTools(ctx, { resolveConfig, debug })
    registerStateTools(ctx, { resolveConfig, debug })
    registerJobTools(ctx, { resolveConfig, debug })
    registerTicketTools(ctx, { resolveConfig, debug })
    registerWatchTool(ctx, { resolveConfig, debug })
    registerConfigTools(ctx, { resolveConfig, debug })
    registerStatusTool(ctx, {
      resolveConfig,
      // Reported per station, so a route that came from the Settings page is distinguishable
      // from one the repository wrote.
      stationDefaults: () => stationDefaultReport(config),
      debug,
    })
    report('registered tools')
    return () => {}
  })

  // The answerer is separate from the tools: it changes permission behaviour rather than
  // adding capability, and with no `[approval]` section it answers nothing.
  ctx.effect(() => {
    registerApprovalAnswerer(ctx, { resolveConfig, debug })
    return () => {}
  })

  // Sessions opened before this build learned to file worktrees, and sessions the user reopened
  // in the GUI, are live but in no project. Reconcile once per process: the cost is one
  // registry read per session, and the alternative is a kitchen whose worktrees stay in
  // "ungrouped" for the rest of their life.
  void reconcileWorkspaces(ctx, report)
}

/** File every session the kitchen knows about under a workspace, creating one where needed. */
async function reconcileWorkspaces(ctx, report) {
  try {
    for (const record of registry.load().values()) {
      if (!record.cwd) continue
      await attachToWorkspace(ctx, record.id, record.cwd, report)
    }
  } catch (error) {
    report('workspace reconciliation stopped:', String(error && error.message ? error.message : error))
  }
}

/**
 * Fill a repository's unset station routes from the bundle's own defaults.
 *
 * The repository stays in control: a `[models.<station>]` table of its own is never overwritten,
 * and neither is an explicit `[harness] default_provider`/`default_model` — a repository that
 * said which route new sessions start on has already answered the question this default exists
 * to answer. Only a station the file says nothing about inherits.
 *
 * The write is a mutation of the resolved configuration object, not of the file: nothing here
 * touches `.dkitchen.toml`, so the default lives in the profile and travels with the plugin.
 */
export function applyStationDefaults(settings, stationDefaults) {
  if (!settings || !stationDefaults) return settings
  const configured = settings.models?.stations ?? {}
  // Whether the file *said* `[harness]`, not whether the resolved object carries a provider:
  // `withHelpers` fills the defaults in, so the latter is always true and would make this
  // default dead code. `declared` is what `load()` records for exactly this question.
  const repositoryChose = settings.declared?.harness === true
  for (const station of DEFAULT_STATIONS) {
    if (configured[station] && Object.keys(configured[station]).length > 0) continue
    if (repositoryChose) continue
    const chosen = defaultRoute(stationDefaults, station)
    if (!chosen) continue
    configured[station] = {
      ...(chosen.provider ? { provider: chosen.provider } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
    }
  }
  settings.models.stations = configured
  return settings
}

/**
 * The station defaults this process is running with, as `{station: {provider, model}}`.
 *
 * Keyed by station for a reader; the lookup underneath is by option name, which is why the
 * field is resolved through `fieldFor` rather than composed by hand.
 */
export function stationDefaultReport(config) {
  const found = {}
  for (const station of DEFAULT_STATIONS) {
    const field = config?.[fieldFor(station)]
    const value = typeof field?.get === 'function' ? field.get() : field
    const route = defaultRoute({ [fieldFor(station)]: value }, station)
    if (route) found[station] = route
  }
  return found
}

/**
 * Report what the kitchen sees for one repository.
 *
 * This is the tool that makes a silent failure visible: when the configuration is broken or a
 * route has no credentials, every other tool refuses, and this one says why in the repository
 * the caller is working in.
 */
function registerStatusTool(ctx, { resolveConfig, stationDefaults = () => ({}), debug }) {
  void debug
  const schema = { type: 'object', additionalProperties: true, properties: {} }
  ctx.tools.register(defineTool({
    name: 'dkitchen_status',
    description: "What dkitchen sees for a repository: its kitchen stations, each station's "
      + 'model route, the approval policy, and whether the configuration loads at all.',
    parameters: {
      cwd: { type: 'string', description: "Repository directory to inspect (default: this session's)" },
    },
    output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const resolved = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent, ctx })
      const bundleDefaults = stationDefaults()
      let settings
      try {
        settings = resolveConfig(resolved.root)
      } catch (error) {
        return {
          available: false,
          root: resolved.root,
          // How the repository was chosen is the difference between "configured wrong" and
          // "never configured here", and the two need different fixes.
          rootSource: resolved.source,
          reason: String(error.message),
        }
      }
      return {
        available: true,
        root: settings.root,
        rootSource: resolved.source,
        repo: settings.repo,
        stations: settings.kitchen.stations,
        routes: Object.fromEntries(
          settings.kitchen.stations.map((station) => [station, settings.route(station)]),
        ),
        approval: settings.approval,
        logIssue: settings.log.issue,
        configFile: settings.root === resolved.root,
        // Which routes came from the bundle's own defaults rather than from this repository,
        // so a surprising route can be traced to the Settings page it was set on.
        stationDefaults: bundleDefaults,
      }
    },
  }))
}
