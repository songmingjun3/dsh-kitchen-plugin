/**
 * Which repository each call is about.
 *
 * A profile plugin is composed once for the whole harness process, but that process serves
 * every repository its conversations are about. So "this repository" cannot come from
 * `process.cwd()`: a plugin that read it once would give every repository the first one's
 * stations and routes.
 *
 * The session is the authority. A session records its `cwd` in its header, and the harness's
 * `workingDirectory` service (injected as `ctx.workingDirectory`) answers per session. A tool
 * body reaches the calling session through `exec.agent.session`, which is what
 * `dsh-tool-bash` uses for the same question. Where none of that is available the process
 * directory is used, and the caller is told which happened — "we guessed" and "we were told"
 * are different facts, and they need different fixes.
 */

/** The directory a session works in, when one is discoverable. */
export function agentCwd(agent) {
  if (!agent || typeof agent !== 'object') return null
  const candidates = [
    agent.session?.header?.cwd,
    agent.session?.meta?.cwd,
    agent.session?.cwd,
    agent.meta?.cwd,
    agent.workingDirectory,
    agent.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * The repository a call should be configured from.
 *
 * Order: an explicit argument, then the harness's own working-directory service, then the
 * session header, then the process directory. `source` records which answered.
 */
export function resolveRoot({ explicit, agent, ctx, fallback = process.cwd() } = {}) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { root: explicit, source: 'argument' }
  }
  const fromService = workingDirectoryOf(ctx, agent)
  if (fromService) return { root: fromService, source: 'session' }
  const fromAgent = agentCwd(agent)
  if (fromAgent) return { root: fromAgent, source: 'agent' }
  return { root: fallback, source: 'process' }
}

/**
 * Ask the harness's working-directory service.
 *
 * The service owns one effective directory per session and exposes it through a projection,
 * so this is the supported answer rather than a field name guessed from another package. A
 * missing service is not an error: older profiles simply do not have it.
 */
function workingDirectoryOf(ctx, agent) {
  const service = ctx && ctx.workingDirectory
  if (!service || typeof service !== 'object') return null
  const session = agent && agent.session
  if (!session) return null
  for (const method of ['current', 'get', 'directoryFor']) {
    if (typeof service[method] !== 'function') continue
    try {
      const value = service[method](session)
      if (typeof value === 'string' && value.trim() !== '') return value
    } catch {
      // A method that rejects for this session is not a reason to stop looking.
    }
  }
  return null
}
