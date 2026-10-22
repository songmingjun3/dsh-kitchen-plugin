/**
 * Sessions, driven from inside the harness process.
 *
 * The plugin runs where the agents live, so `ctx.agents` can create a session and
 * `ctx.sessions` can read it back. There is no second harness process, no message queue, and
 * no route selector to negotiate — a session is created with its route up front.
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
  sessionId, cwd, route, config, debug, name,
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

  // The harness files a session under the working directory it is given and composes the
  // file and shell tools from it. Without `meta.cwd` the session lands in `_no-cwd`, where
  // those tools do not exist at all: a station that cannot read a file cannot do its job.
  //
  // The preset is the second half of the same fact. A session that names none runs with the
  // root tool registry only — dkitchen's tools and nothing to read or run — so the station
  // answers and reports that it cannot open a file. Naming the preset in the header alone
  // records the choice; `agentPresets.mount` is what actually composes the tools into the
  // agent, which is why both are set here and neither is enough on its own.
  const options = { sessionId, agentOptions }
  const presets = ctx.agentPresets
  if (cwd || presets) {
    options.meta = {}
    if (cwd) options.meta.cwd = cwd
    if (presets) options.meta.agentPreset = AGENT_PRESET
  }
  if (presets) {
    options.setup = async (agentCtx) => {
      await presets.mount(agentCtx, AGENT_PRESET)
    }
  }

  let handle
  try {
    handle = await ctx.agents.create(options)
  } catch (error) {
    throw new SessionError(
      `cannot create a session on ${route.provider}/${route.model}: ${describe(error)}`,
    )
  }

  // A session the GUI cannot file under a project reads as "ungrouped", which for a station
  // is wrong: it works in that repository and the user watches it there.
  await attachToWorkspace(ctx, sessionId, cwd, log)

  // The title the user reads in the window is the harness's own, and it is generated from the
  // first message unless something pins it — which is why a station shows up as "厨房配置检查"
  // instead of 统筹. Renaming with the user source also stops later automatic generation.
  titleSession(ctx, handle && handle.agent && handle.agent.session, name, log)

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

/**
 * File a new session under the workspace whose path is its own, when the harness has one.
 *
 * Membership is explicit: the client lists a session under a project only when the workspace
 * record names it, so a session created outside the GUI's start-a-session path stays in the
 * ungrouped bucket. The registry validates the session's cwd against the workspace path, so a
 * mismatch is refused rather than misfiled; the caller keeps working either way.
 */
async function attachToWorkspace(ctx, sessionId, cwd, log) {
  const registry = ctx.workspaceRegistry
  if (!cwd || !registry || typeof registry.list !== 'function') return
  let workspace
  try {
    const spaces = await registry.list()
    workspace = (Array.isArray(spaces) ? spaces : []).find(options => samePath(options.path, cwd))
  } catch (error) {
    log('cannot read the workspace registry:', describe(error))
    return
  }
  if (!workspace || typeof workspace.attachSession !== 'function') return
  try {
    await workspace.attachSession(sessionId)
    log('attached', sessionId, 'to', workspace.path)
  } catch (error) {
    log('cannot attach', sessionId, 'to', workspace.path + ':', describe(error))
  }
}

/** Whether two directory paths name the same place, allowing for Windows case and \\?\ prefixes. */
function samePath(left, right) {
  const normal = (value) => {
    const text = String(value ?? '').replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? text.toLowerCase() : text
  }
  return normal(left) !== '' && normal(left) === normal(right)
}

/**
 * Pin a session's harness title to the name the kitchen gave it.
 *
 * `sessionTitle.rename` appends a user-sourced title event, which both sets the title and
 * supersedes automatic generation — so the station keeps its role name after every later
 * message. A harness without the service, or one that refuses a title, is not a reason to
 * fail the session: the station works, and the board still shows the kitchen's own name.
 */
export function titleSession(ctx, session, name, log = () => {}) {
  const titles = ctx.sessionTitle
  if (!titles || typeof titles.rename !== 'function' || !session || !name) return
  try {
    titles.rename(session, name)
  } catch (error) {
    log('cannot title the session:', describe(error))
  }
}

/** The preset every station runs: the harness's full tool composition. */
export const AGENT_PRESET = 'standard'

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
