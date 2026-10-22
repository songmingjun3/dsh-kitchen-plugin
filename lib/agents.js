/**
 * Sessions, driven from inside the harness process.
 *
 * This replaces the Python runtime's ACP client, broker, and ACP profile in one move: the
 * plugin runs where the agents live, so `ctx.agents` can create one and `ctx.sessions` can
 * read it back. There is no second harness process, no message queue, and no route selector
 * to negotiate — a session is created with its route up front.
 *
 * Two facts about the platform shape everything here:
 *
 * - `whenIdle()` lives on `handle.agent`, not on the handle, and it resolves only after the
 *   whole agent — subagents included — reaches quiescence.
 * - A tool's return value must be lossless JSON. Session content holds objects the transport
 *   cannot represent, so anything crossing back into a tool result is stringified field by
 *   field rather than passed through.
 */

/** A failure a session operation reports, phrased for the model to act on. */
export class SessionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionError'
  }
}

/**
 * Create a session on `route` and send it one message.
 *
 * `route` is `{provider, model, effort}`. A route the profile does not offer fails here, with
 * the names it does offer: the alternative is the session running on the profile default and
 * the user discovering it from a reply they did not expect.
 */
export async function createSession(ctx, {
  sessionId, cwd, route, config, debug,
}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}
  log('creating', sessionId, 'on', route.provider, '/', route.model)

  for (const key of ['agents', 'sessions']) {
    if (!ctx[key]) throw new SessionError(`this harness does not expose ctx.${key}; dkitchen cannot open sessions`)
  }

  const agentOptions = { provider: route.provider, model: route.model }
  if (route.effort) {
    // `effort` is only accepted by models that declare a reasoning level. A rejected value
    // must not stop the session from opening; the caller learns it was ignored.
    agentOptions.reasoningEffort = route.effort
  }

  let handle
  try {
    handle = await ctx.agents.create({ sessionId, agentOptions })
  } catch (error) {
    throw new SessionError(
      `cannot create a session on ${route.provider}/${route.model}: ${describe(error)}`,
    )
  }

  const record = {
    id: sessionId,
    name: '',
    station: '',
    cwd: cwd ?? '',
    created_ns: Date.now() * 1_000_000,
    issue: null,
    repo: null,
    provider: route.provider ?? null,
    model: route.model ?? null,
    effort: route.effort ?? null,
    closed: false,
  }

  return { handle, record, log }
}

/** Send one user-role message into a session's inbox and wait for the turn to finish. */
export async function followup(handle, text, { wait = true, log = () => {} } = {}) {
  if (!handle || !handle.agent) throw new SessionError('this session is not open in this process')
  try {
    await handle.agent.followup({
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    })
  } catch (error) {
    throw new SessionError(`cannot deliver the message: ${describe(error)}`)
  }
  if (!wait) return
  try {
    await handle.agent.whenIdle()
  } catch (error) {
    throw new SessionError(`the turn did not settle: ${describe(error)}`)
  }
  log('turn settled')
}

/**
 * The messages a session has, reduced to plain records.
 *
 * `deriveMessages()` returns the model-facing projection, which holds objects a tool result
 * cannot carry. Every field is converted here, so callers never hand the transport something
 * it will refuse.
 */
export function readMessages(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (!session) return []
  const messages = session.deriveMessages()
  if (!Array.isArray(messages)) return []
  return messages.map((message) => ({
    role: String(message.role ?? ''),
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({
        type: String(block?.type ?? ''),
        text: block?.type === 'text' ? String(block.text ?? '') : '',
      }))
      : [],
  }))
}

/** The latest assistant text in a session, or null when it has not answered yet. */
export function latestReply(ctx, sessionId) {
  const messages = readMessages(ctx, sessionId)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return null
}

/** Whether a session is currently running a turn. */
export function sessionState(handle) {
  if (!handle || !handle.agent) return 'unknown'
  const agent = handle.agent
  if (typeof agent.isIdle === 'function') return agent.isIdle() ? 'idle' : 'working'
  if (typeof agent.state === 'function') return String(agent.state())
  return 'unknown'
}

/**
 * The directory a session works in.
 *
 * A profile plugin is composed once for the whole process, and that process serves whatever
 * directory the user started the harness in — not the repository each conversation is about.
 * So "this repository" has to come from the session, and this is where that lives: the meta
 * the harness records when the session is created.
 */
export function sessionCwd(ctx, sessionId) {
  if (!ctx.sessions) return null
  const session = ctx.sessions.get(sessionId)
  if (!session) return null
  const candidates = [
    session.meta?.cwd,
    session.cwd,
    session.meta?.workingDirectory,
    session.workingDirectory,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** The live sessions this harness process holds, as `{id, ...}` records. */
export function liveSessions(ctx) {
  if (!ctx.sessions) return []
  const sessions = ctx.sessions.list()
  if (!Array.isArray(sessions)) return []
  return sessions.map((session) => ({
    id: String(session.id ?? session.meta?.id ?? ''),
  })).filter((session) => session.id)
}

function describe(error) {
  if (!error) return 'unknown error'
  const message = error.message ?? String(error)
  return String(message).split(/\s+/).join(' ').trim()
}
