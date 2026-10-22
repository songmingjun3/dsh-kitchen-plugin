/**
 * dkitchen as a DeepSeek Harness plugin.
 *
 * The Python runtime this replaces needed three processes to do the same work: a broker
 * holding an ACP connection, the harness that connection drove, and an MCP server the tools
 * arrived through. None of that is necessary in-process. Sessions come from `ctx.agents`,
 * replies from `ctx.sessions`, and the tools register on `ctx.tools` directly — so installing
 * this bundle is the whole installation.
 *
 * One consequence of that move shapes everything here. A profile plugin is composed once, for
 * the whole process, but a kitchen belongs to a repository — and the harness serves many
 * repositories from that process. So the configuration is resolved **per call**, from the
 * directory a session works in, never once at mount time. A plugin that read
 * `process.cwd()` at startup would give every repository the first one's stations and routes.
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

export const name = 'dkitchen'

/**
 * Services this plugin needs.
 *
 * A profile without them leaves the plugin inactive rather than broken, which is the harness's
 * own convention: the plugin waits instead of throwing during composition.
 */
export const inject = ['tools', 'agents', 'sessions']

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

  ctx.effect(() => {
    registerSessionTools(ctx, { resolveConfig, debug })
    registerStateTools(ctx, { resolveConfig, debug })
    registerStatusTool(ctx, { resolveConfig, debug })
    report('registered tools')
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
  const schema = { type: 'object', additionalProperties: true, properties: {} }
  ctx.tools.register(defineTool({
    name: 'dkitchen_status',
    description: "What dkitchen sees for a repository: its kitchen stations, each station's "
      + 'model route, and whether the configuration loads at all.',
    parameters: {
      cwd: { type: 'string', description: 'Repository directory to inspect (default: this session\'s)' },
    },
    output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const resolved = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent })
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
        hasConfig: settings.root !== undefined && resolved.source !== 'process'
          ? true
          : undefined,
      }
    },
  }))
}
