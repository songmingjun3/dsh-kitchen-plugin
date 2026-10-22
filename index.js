/**
 * dkitchen as a DeepSeek Harness plugin.
 *
 * The Python runtime this replaces needed three processes to do the same work: a broker
 * holding an ACP connection, the harness that connection drove, and an MCP server the tools
 * arrived through. A plugin lives where the agents do, so `ctx.agents` creates a session,
 * `ctx.sessions` reads the reply back, and `ctx.tools` carries the tools. Installing the
 * bundle is then the whole installation — no `pip install`, no `ding plugin install`, no
 * kitchen profile, no broker.
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
import { resolveRoot } from './lib/cwd.js'
import { registerSessionTools } from './lib/tools.js'
import { registerStateTools } from './lib/state-tools.js'
import { registerJobTools } from './lib/job-tools.js'
import { registerTicketTools } from './lib/ticket-tools.js'
import { registerWatchTool } from './lib/watch-tools.js'
import { registerApprovalAnswerer } from './lib/approval.js'
import { registerConfigTools } from './lib/config-tools.js'
import { ensureSkill, installedSkill } from './lib/skill.js'

export const name = 'dkitchen'

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
]

/**
 * Mount the kitchen.
 *
 * `config` is the row's configuration from `cordis.patch.yml`; `debug` there turns on the
 * registration trace. `config.root` optionally pins the repository, for a profile that serves
 * exactly one; without it each call resolves its own.
 */
export function apply(ctx, config = {}) {
  const debug = config.debug === true
  const report = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  // Resolved per call, because a process serves many repositories. A failure is returned to
  // the caller as a configuration error rather than thrown at mount time: one repository with
  // a broken `.dkitchen.toml` must not remove the tools from every other one.
  const resolveConfig = (cwd) => {
    const root = config.root ?? cwd ?? process.cwd()
    try {
      const settings = load(root, { root })
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
    registerStatusTool(ctx, { resolveConfig, debug })
    report('registered tools')
    return () => {}
  })

  // The answerer is separate from the tools: it changes permission behaviour rather than
  // adding capability, and with no `[approval]` section it answers nothing.
  ctx.effect(() => {
    registerApprovalAnswerer(ctx, { resolveConfig, debug })
    return () => {}
  })
}

/**
 * Report what the kitchen sees for one repository.
 *
 * This is the tool that makes a silent failure visible: when the configuration is broken or a
 * route has no credentials, every other tool refuses, and this one says why in the repository
 * the caller is working in.
 */
function registerStatusTool(ctx, { resolveConfig, debug }) {
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
      }
    },
  }))
}
