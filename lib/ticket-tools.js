/**
 * The orchestrator's tools: relay, merge, log.
 *
 * Each one is only useful with `gh` installed, so each reports its absence as its own answer
 * rather than failing somewhere deeper. The refusals matter as much as the actions — a merge
 * that happened at an unreviewed HEAD, or a relay whose message was never delivered, is worse
 * than a clear refusal.
 */

import { defineTool } from './registry-access.js'
import * as github from './github.js'
import * as orchestrate from './orchestrate.js'
import { resolveRoot } from './cwd.js'
import { handles } from './tools.js'
import { resolveTarget } from './target.js'
import { followup, liveSessions } from './agents.js'

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Resolve the repository once, reporting a missing `gh` as this tool's own answer. */
function requireGitHub(ctx, resolveConfig, exec, explicit) {
  if (!github.available()) {
    throw new Error('the gh CLI is not installed; relay, merge, log, and watch need it')
  }
  const root = resolveRoot({ explicit, agent: exec && exec.agent, ctx })
  const config = resolveConfig(root.root)
  return { config, repo: config.repository(), cwd: root.root, rootSource: root.source }
}

export function registerTicketTools(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.tools.register(defineTool({
    name: 'dkitchen_relay',
    description: "Send a message to a ticket's executor and, only once delivery is confirmed, "
      + 'leave it on the ticket. Needs the gh CLI.',
    parameters: {
      ticket: { type: 'number', required: true, description: 'Ticket number in this repository' },
      message: { type: 'string', required: true, description: 'What the executor receives' },
      comment: { type: 'string', description: 'Ticket comment (default: the message itself)' },
      no_comment: { type: 'boolean', description: 'Send only; leave no ticket comment' },
      to: { type: 'string', description: "Executor session id or name, when the ticket has no owner line" },
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const { config, repo, cwd } = requireGitHub(ctx, resolveConfig, exec, args.cwd)
      const body = orchestrate.signed(args.message, config)
      // Delivery first: a comment left before the message arrived would claim work that never
      // started.
      const target = args.to ?? `${repo}#${args.ticket}`
      const sent = await sendToSession(ctx, target, body, config)
      if (!sent.delivered) {
        return {
          delivered: false,
          commented: false,
          reason: `delivery was not confirmed (${sent.reason}); no comment was left`,
        }
      }
      if (args.no_comment) return { delivered: true, commented: false }
      const url = github.comment({
        repo, issue: args.ticket, body: orchestrate.signed(args.comment ?? args.message, config), cwd,
      })
      log('relayed to', target)
      return { delivered: true, commented: true, url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_merge',
    description: 'Merge a reviewed PR, but only at the HEAD that was reviewed, and only once '
      + "the ticket's executor is waiting on the orchestrator. Needs the gh CLI.",
    parameters: {
      pr: { type: 'number', required: true, description: 'PR number' },
      sha: { type: 'string', required: true, description: 'The HEAD that was reviewed (full or prefix)' },
      ticket: { type: 'number', description: "The PR's ticket" },
      no_ticket: { type: 'boolean', description: 'Merge a PR that belongs to no ticket' },
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const { config, repo, cwd } = requireGitHub(ctx, resolveConfig, exec, args.cwd)
      const notes = []
      const say = (message) => {
        notes.push(message)
        return { merged: false, refused: message }
      }
      const outcome = orchestrate.merge({
        pr: args.pr,
        sha: args.sha,
        ticket: args.ticket,
        noTicket: args.no_ticket === true,
        repo,
        cwd,
        config,
        say,
      })
      return { ...outcome, notes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_log',
    description: "Post a signed, UTC-stamped entry to the orchestrator log ticket. Needs the "
      + 'gh CLI.',
    parameters: {
      items: {
        type: 'array', items: { type: 'string' }, required: true,
        description: 'Automatic actions, one line each',
      },
      pending: {
        type: 'array', items: { type: 'string' },
        description: 'Matters waiting for the user',
      },
      issue: { type: 'number', description: 'Log ticket (default: [log] issue from .dkitchen.toml)' },
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const { config, repo, cwd } = requireGitHub(ctx, resolveConfig, exec, args.cwd)
      const issue = args.issue ?? config.log.issue
      if (issue === undefined || issue === null) {
        throw new Error('no orchestrator log ticket; set [log] issue in .dkitchen.toml or pass issue')
      }
      const body = orchestrate.logBody(args.items ?? [], args.pending ?? [], new Date(), config)
      const url = github.comment({ repo, issue, body, cwd })
      log('logged to', `#${issue}`)
      return { issue, url, body }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dkitchen_executor_status',
    description: "The latest executor comment on a ticket: its status block, whether it waits "
      + 'on the orchestrator, and its URL.',
    parameters: {
      ticket: { type: 'number', required: true, description: 'Ticket number in this repository' },
      cwd: { type: 'string', description: "Repository directory (default: this session's)" },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const { config, repo, cwd } = requireGitHub(ctx, resolveConfig, exec, args.cwd)
      const status = orchestrate.executorStatus({ repo, issue: args.ticket, cwd, config })
      if (!status) throw new Error(`#${args.ticket} has no executor comment`)
      return { ticket: args.ticket, ...status }
    },
  }))
}

/**
 * Deliver a message to the session a ticket names.
 *
 * This runs the same resolution `dkitchen_send` uses, including the beginning-of-comment rule:
 * an owner line beats a signature line.
 */
async function sendToSession(ctx, target, body, config) {
  let sessionId
  try {
    sessionId = resolveTarget(target, null, config, {
      knownSessions: () => liveSessions(ctx),
    })
  } catch (error) {
    return { delivered: false, reason: String(error.message).split(/\s+/).join(' ') }
  }
  const handle = handles.get(sessionId)
  if (!handle) {
    return {
      delivered: false,
      reason: `session ${sessionId} is not open in this harness process`,
    }
  }
  try {
    await followup(handle, body, { wait: true })
    return { delivered: true, session: sessionId }
  } catch (error) {
    return { delivered: false, reason: String(error.message).split(/\s+/).join(' ') }
  }
}
