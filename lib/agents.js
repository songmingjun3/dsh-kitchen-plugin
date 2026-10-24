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

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

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
 *
 * `station` selects the permission preset from `[permissions]`, when the repository names one:
 * an executor that must run training scripts cannot stop at a sandbox prompt mid-ticket.
 */
export async function createSession(ctx, {
  sessionId, cwd, route, config, debug, name, station,
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

  // The permission the station runs under, before its first message: an executor that hits a
  // sandbox prompt mid-ticket stops there until a human answers, and while the user is away
  // that is a stalled run rather than a question.
  applyPermission(ctx, handle, station, config, log)

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
 *
 * A ticket's executor works in its own worktree, and a worktree is a directory of its own. The
 * registry has no notion of a directory belonging to two projects, so the session cannot join
 * the repository's workspace; it gets a workspace of its own instead, named after the worktree.
 * That is what keeps it out of "ungrouped", and in the client's tree view it lands under the
 * repository it was cut from.
 */
export async function attachToWorkspace(ctx, sessionId, cwd, log = () => {}) {
  const registry = ctx.workspaceRegistry
  if (!cwd || !registry || typeof registry.list !== 'function') return
  let spaces
  try {
    spaces = await registry.list()
  } catch (error) {
    log('cannot read the workspace registry:', describe(error))
    return
  }
  if (!Array.isArray(spaces)) return

  const workspace = spaces.find((options) => samePath(options.path, cwd))
    ?? await workspaceForNested(ctx, registry, spaces, cwd, log)
  if (!workspace || typeof workspace.attachSession !== 'function') return
  try {
    await workspace.attachSession(sessionId)
    log('attached', sessionId, 'to', workspace.path)
  } catch (error) {
    log('cannot attach', sessionId, 'to', workspace.path + ':', describe(error))
  }
}

/**
 * Put a new session under the permission preset its station was configured with.
 *
 * `permissionPresets.set` is the same write the `/permission` command performs: it appends the
 * durable preset event and moves the sandbox and approval knobs with it, so the choice is part
 * of the session's record rather than a side effect that vanishes on reload. A repository that
 * names no preset for the station, or a harness without the service, leaves the session on the
 * default it was created with.
 */
export function applyPermission(ctx, handle, station, config, log = () => {}) {
  const service = ctx.permissionPresets
  const session = handle && handle.agent && handle.agent.session
  if (!service || typeof service.set !== 'function' || !session || !station || !config) return
  let wanted
  try {
    wanted = typeof config.permissionFor === 'function' ? config.permissionFor(station) : null
  } catch (error) {
    log('cannot read [permissions]:', describe(error))
    return
  }
  if (!wanted) return
  try {
    if (typeof service.current === 'function' && service.current(session) === wanted) return
    service.set(session, wanted)
    log('set', station, 'session', session.id, 'to permission', wanted)
  } catch (error) {
    log('cannot set permission', wanted + ':', describe(error))
  }
}

/**
 * The workspace a directory inside another workspace should be filed under.
 *
 * Only a directory that stands on its own gets one: a git worktree carries a `.git` file, and
 * nothing else the kitchen opens needs a project of its own. Creating it lazily means the two
 * worktrees an afternoon produces do not each need a human to add a folder in the GUI.
 */
async function workspaceForNested(ctx, registry, spaces, cwd, log) {
  if (typeof registry.create !== 'function') return undefined
  if (!existsSync(join(cwd, '.git'))) return undefined
  const parent = spaces
    .filter((options) => isInside(cwd, options.path))
    .sort((left, right) => String(right.path).length - String(left.path).length)[0]
  if (!parent) return undefined
  try {
    const title = basename(cwd) || cwd
    const created = await registry.create(cwd, title)
    log('created workspace', title, 'for', cwd, 'inside', parent.path)
    return created
  } catch (error) {
    log('cannot create a workspace for', cwd + ':', describe(error))
    return undefined
  }
}

/** Whether `child` sits below `parent` on disk. */
function isInside(child, parent) {
  const normal = (value) => String(value ?? '').replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '')
  const target = normal(parent)
  const subject = normal(child)
  if (!target || !subject || subject.length <= target.length) return false
  if (!samePath(subject.slice(0, target.length), target)) return false
  const boundary = subject[target.length]
  return boundary === '\\' || boundary === '/'
}

/** Whether two directory paths name the same place, allowing for Windows case and \\?\ prefixes. */function samePath(left, right) {
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
      // A message needs an identity of its own: the stored `user/message` event carries it, and
      // a session whose event lacks one is refused as corrupt when it is next loaded. The
      // loop identifies messages it mints itself; a message handed in from here is stored as
      // given, so the id is part of the caller's contract rather than an afterthought.
      id: crypto.randomUUID(),
      role: 'user',
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
 * A handle for any live session, including the ones the user opened rather than the kitchen.
 *
 * The plugin's own `handles` map only knows the sessions this instance created. A station the
 * user reopened in the GUI after a restart is live in the same process but absent from that
 * map, and refusing to message it is what made the designer unable to reach the orchestrator:
 * the session was there the whole time. `ctx.agents.get` answers for every live agent.
 */
export function liveHandle(ctx, sessionId) {
  const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined
  return agent ? { agent } : undefined
}

/**
 * A handle for a session that exists on disk but is not loaded in this process.
 *
 * The harness loads a session when someone opens it and drops it when the process restarts;
 * what stays is the log. A station created before the restart is then "not open" even though
 * every message it ever exchanged is still there, which is what broke an executor's report to
 * the orchestrator. `agents.resume` reads that log back and publishes the agent, so the
 * message lands in the same conversation rather than a replacement.
 *
 * The resumed agent is bound to the same preset a fresh station gets, so a session that comes
 * back this way can still read a file and run a command.
 */
export async function resumeSession(ctx, sessionId, route, cwd, log = () => {}) {
  if (!ctx.agents || typeof ctx.agents.resume !== 'function') return undefined
  const options = { resumeSessionId: sessionId }
  if (route && (route.provider || route.model)) {
    options.agentOptions = { provider: route.provider, model: route.model }
    if (route.effort) options.agentOptions.reasoningEffort = route.effort
  }
  const presets = ctx.agentPresets
  if (presets && typeof presets.mount === 'function') {
    options.setup = async (agentCtx) => {
      await presets.mount(agentCtx, AGENT_PRESET)
    }
  }
  try {
    const handle = await ctx.agents.resume(options)
    log('resumed', sessionId)
    return handle
  } catch (error) {
    log('cannot resume', sessionId + ':', describe(error))
    return undefined
  }
}

/**
 * Make sure a stored session is loaded, so a reader sees its log rather than nothing.
 *
 * Sending needs a handle; reading needs only that the session exist in `ctx.sessions`. Both
 * start from the same fact — the process keeps live sessions, the disk keeps all of them — so
 * the resume path is shared. A session that is already loaded is left alone.
 */
export async function ensureLoaded(ctx, sessionId, record, config, log = () => {}) {
  if (ctx.sessions && typeof ctx.sessions.get === 'function' && ctx.sessions.get(sessionId)) return true
  const route = record
    ? { provider: record.provider, model: record.model, effort: record.effort }
    : config && typeof config.route === 'function' ? config.route('executor') : null
  const handle = await resumeSession(ctx, sessionId, route, record?.cwd, log)
  return handle !== undefined
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
