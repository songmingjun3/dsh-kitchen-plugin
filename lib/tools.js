/**
 * dkitchen's model-facing session tools.
 *
 * Each tool is a thin wrapper over `lib/`, and its description says what it does in the
 * kitchen's vocabulary rather than the harness's. Three rules hold for every tool here:
 *
 * - The output schema names `additionalProperties` explicitly. The registry refuses a raw
 *   `{type: 'object'}` with `JsonSchemaError`, and — because registration failures are silent
 *   — the only visible symptom would be a tool that never appears.
 * - The returned value is lossless JSON. Session content is not, so `lib/agents.js` reduces it
 *   to strings before it gets here.
 * - The configuration is resolved per call, from the directory the session works in, because
 *   one harness process serves many repositories.
 */

import * as registry from './registry.js'
import { defineTool } from './registry-access.js'
import * as agents from './agents.js'
import { resolveRoot } from './cwd.js'
import { resolveTarget, replyHead } from './target.js'

/**
 * The handles this plugin opened.
 *
 * `ctx.agents.get()` returns an `Agent`, but delivering a message needs the `AgentHandle`
 * that `create()` returned, and the harness keeps no map from one to the other. Recording
 * them here is what lets `send` reach a session this plugin created; a session someone else
 * opened is reported as not open here rather than silently failing.
 */
const handles = new Map()

/** A plain object schema the registry accepts. */
const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Register the session tools.
 *
 * `resolveConfig(cwd)` returns the repository's configuration or throws `ConfigError`. It is
 * called inside each tool, so a broken file in one repository affects only that repository.
 */
export function registerSessionTools(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.tools.register(defineTool({
    name: 'dkitchen_new_session',
    description: 'Open a DeepSeek Harness session for a kitchen station and send it its first '
      + 'message. Returns the session id dkitchen records for it, and the reply when the first '
      + 'turn has finished.',
    parameters: {
      name: { type: 'string', required: true, description: 'Session title, shown on the board' },
      message: { type: 'string', required: true, description: 'First message text' },
      station: {
        type: 'string',
        description: 'orchestrator, designer, verifier, or executor (default: executor)',
      },
      cwd: { type: 'string', description: "Working directory (default: this session's)" },
      issue: { type: 'number', description: 'Ticket this session owns' },
      provider: { type: 'string', description: 'Provider route, overriding [models.<station>]' },
      model: { type: 'string', description: 'Model, overriding [models.<station>]' },
      wait: {
        type: 'boolean',
        description: 'Wait for the first turn to finish before returning (default: true)',
      },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const cwd = resolveRoot({ explicit: args.cwd, agent: exec && exec.agent, ctx }).root
      const config = resolveConfig(cwd)
      const station = args.station ?? 'executor'
      if (!config.includes(station)) {
        throw new Error(
          `${station} is not one of this kitchen's stations `
          + `(${config.kitchen.stations.join(', ')}); add it in .dkitchen.toml first`,
        )
      }
      const route = config.route(station)
      if (args.provider || args.model) {
        route.provider = args.provider ?? route.provider
        route.model = args.model ?? route.model
      }
      const sessionId = `session-${crypto.randomUUID()}`
      // The name carries the ticket when there is one, through the repository's own template.
      const name = args.issue
        ? config.sessionName({ issue: args.issue, name: args.name, repo: config.repo })
        : args.name

      const opened = await agents.createSession(ctx, { sessionId, cwd, route, config, debug, name })
      handles.set(sessionId, opened.handle)
      registry.put({
        ...opened.record,
        name,
        station,
        cwd,
        issue: args.issue ?? null,
        repo: args.issue ? config.repo : null,
      })
      log('recorded', sessionId, 'as', name)

      let text = String(args.message)
      if (args.issue) {
        const line = `${config.sessions.owner_line}: ${sessionId}`
        text = `You own ticket ${config.repository()}#${args.issue}. Before anything else, post a `
          + `comment on it with the line \`${line}\`.\n\n${text}`
      }
      await agents.followup(opened.handle, text, { wait: args.wait !== false, log })
      const reply = agents.latestReply(ctx, sessionId)
      return {
        session: sessionId,
        name,
        station,
        route,
        reply: reply === null ? null : replyHead(reply),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_send',
    description: 'Send a message to a session and, by default, wait for its turn to settle. '
      + 'Address it by session id, exact name, #42, OWNER/REPO#42, or an issue URL.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id, name, #42, or issue URL' },
      message: { type: 'string', required: true, description: 'Message text' },
      sender: { type: 'string', description: "Prefix the message with '[from NAME]'" },
      wait: { type: 'boolean', description: 'Wait for the turn to settle (default: false)' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const config = resolveConfig(resolveRoot({ agent: exec && exec.agent, ctx }).root)
      const sessionId = resolveTarget(args.target, null, config, {
        knownSessions: () => agents.liveSessions(ctx),
      })
      const handle = handles.get(sessionId) ?? await handleFor(ctx, sessionId, config, log)
      if (!handle) {
        throw new Error(
          `session ${sessionId} is not open in this harness process and could not be resumed; `
          + 'open it once in the harness, then send again',
        )
      }
      const text = args.sender ? `[from ${args.sender}]\n${args.message}` : String(args.message)
      await agents.followup(handle, text, { wait: args.wait === true, log })
      return { session: sessionId, delivered: true, waited: args.wait === true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_read',
    description: "A session's latest reply. Use head to keep only its first paragraph.",
    parameters: {
      target: { type: 'string', required: true, description: 'Session id, name, #42, or issue URL' },
      head: { type: 'boolean', description: 'Only the first paragraph' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const config = resolveConfig(resolveRoot({ agent: exec && exec.agent, ctx }).root)
      const sessionId = resolveTarget(args.target, null, config, {
        knownSessions: () => agents.liveSessions(ctx),
      })
      const reply = agents.latestReply(ctx, sessionId)
      if (reply === null) {
        throw new Error(`session ${sessionId} has no final reply yet; it may still be working`)
      }
      return { session: sessionId, text: args.head ? replyHead(reply) : reply }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_info',
    description: "One session's id, name, working directory, station, ticket, and model route.",
    parameters: {
      target: { type: 'string', required: true, description: 'Session id, name, #42, or issue URL' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const config = resolveConfig(resolveRoot({ agent: exec && exec.agent, ctx }).root)
      const sessionId = resolveTarget(args.target, null, config, {
        knownSessions: () => agents.liveSessions(ctx),
      })
      const record = registry.get(sessionId)
      return {
        session: sessionId,
        live: agents.liveSessions(ctx).some((session) => session.id === sessionId),
        name: record?.name ?? null,
        station: record?.station ?? null,
        cwd: record?.cwd ?? null,
        issue: record?.issue ?? null,
        repo: record?.repo ?? null,
        route: record
          ? { provider: record.provider, model: record.model, effort: record.effort }
          : null,
      }
    },
  }))
}

/** Exposed so a later phase can drop a handle when its session is closed. */
export { handles }

/**
 * The handle to send through: one this plugin opened, one the harness holds, or one read back
 * from its log.
 *
 * A session is loaded when it is opened and dropped when the process restarts; only the log
 * survives. Messaging a station that was created before the restart therefore needs a resume,
 * not a refusal — the conversation, its ticket and its title are all still on disk. The
 * kitchen's own row supplies the route, so the resumed agent keeps the model it was opened on.
 */
async function handleFor(ctx, sessionId, config, log) {
  const opened = handles.get(sessionId) ?? agents.liveHandle(ctx, sessionId)
  if (opened) return opened
  const record = registry.get(sessionId)
  const route = record
    ? { provider: record.provider, model: record.model, effort: record.effort }
    : config.route(record?.station ?? 'executor')
  const resumed = await agents.resumeSession(ctx, sessionId, route, record?.cwd, log)
  if (resumed) handles.set(sessionId, resumed)
  return resumed
}
