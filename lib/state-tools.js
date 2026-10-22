/**
 * The state tools: what the kitchen knows about its own sessions.
 *
 * These read dkitchen's registry rather than the harness's event log. A plugin lives inside one
 * process, so what it can see is what this process holds plus what it recorded; a session the
 * window opened, or another harness process owns, is outside that reach. `board` says so in its
 * own description instead of implying it lists everything on the machine.
 */

import { defineTool } from './registry-access.js'
import * as agents from './agents.js'
import * as registry from './registry.js'
import { resolveRoot } from './cwd.js'
import { resolveTarget } from './target.js'

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function registerStateTools(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.tools.register(defineTool({
    name: 'dkitchen_list_sessions',
    description: 'Every session this harness process holds, with the kitchen name and station '
      + 'dkitchen recorded for each.',
    parameters: {},
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(_args, exec) {
      const live = agents.liveSessions(ctx)
      const records = registry.load()
      return {
        count: live.length,
        sessions: live.map((session) => {
          const record = records.get(session.id)
          return {
            session: session.id,
            name: record?.name ?? null,
            station: record?.station ?? null,
            cwd: record?.cwd ?? null,
            closed: record?.closed ?? false,
          }
        }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_board',
    description: 'List the kitchen sessions this harness process holds, with the station, '
      + 'ticket, working directory, and latest reply each one has. Sessions opened outside '
      + 'dkitchen are not in the registry and appear without a name or station.',
    parameters: {
      status: { type: 'boolean', description: "Include each session's latest reply, truncated" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const live = agents.liveSessions(ctx)
      const records = registry.load()
      const rows = live.map((session) => {
        const record = records.get(session.id)
        const row = {
          session: session.id,
          name: record?.name ?? null,
          station: record?.station ?? null,
          cwd: record?.cwd ?? null,
          issue: record?.issue ?? null,
          repo: record?.repo ?? null,
          closed: record?.closed ?? false,
        }
        if (args.status) {
          const reply = agents.latestReply(ctx, session.id)
          row.reply = reply === null ? null : reply.slice(0, 200)
        }
        return row
      })
      log('board rows:', rows.length)
      return { count: rows.length, sessions: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_session_status',
    description: "One session's turn state: whether this process holds it, and what its last "
      + 'message was.',
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
      const messages = agents.readMessages(ctx, sessionId)
      return {
        session: sessionId,
        live: agents.liveSessions(ctx).some((session) => session.id === sessionId),
        messageCount: messages.length,
        lastRole: messages.at(-1)?.role ?? null,
        closed: record?.closed ?? false,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_rename',
    description: 'Rename a session: both the name dkitchen records and the harness title the '
      + 'window shows.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id, name, #42, or issue URL' },
      name: { type: 'string', required: true, description: 'New name' },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const config = resolveConfig(resolveRoot({ agent: exec && exec.agent, ctx }).root)
      const sessionId = resolveTarget(args.target, null, config, {
        knownSessions: () => agents.liveSessions(ctx),
      })
      const updated = registry.rename(sessionId, args.name)
      if (!updated) {
        throw new Error(`dkitchen has no record of ${sessionId}; it was not opened by the kitchen`)
      }
      // The window shows the harness title, not this row; keep the two from disagreeing.
      agents.titleSession(ctx, ctx.sessions.get(sessionId), args.name, log)
      log('renamed', sessionId, 'to', args.name)
      return { session: sessionId, name: updated.name }
    },
  }))
}
