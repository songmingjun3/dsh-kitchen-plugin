/**
 * Which repository each call is about.
 *
 * A profile plugin is composed once for the whole harness process, and that process serves
 * whatever directory the user launched it from — not the repository each conversation happens
 * to be about. So "this repository" cannot come from `process.cwd()` alone, and it cannot be
 * trusted to match what the model means.
 *
 * The harness does not hand a tool body the calling agent's directory in a shape this plugin
 * could verify against the installed release (`exec.agent` exists, but its members differ and
 * are not documented), so this does not pretend to derive it. Instead every tool that needs a
 * repository takes one, and falls back to the process directory while saying which it used.
 * A wrong repository is then visible in the tool's own output rather than showing up later as
 * a session on the wrong stations.
 */

/**
 * The repository a call should be configured from.
 *
 * `explicit` wins, then `agent.workingDirectory` when the installed harness exposes it, then
 * the process directory. `source` says which, so a caller can tell a configured kitchen from
 * one that fell back.
 */
export function resolveRoot({ explicit, agent, fallback = process.cwd() } = {}) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { root: explicit, source: 'argument' }
  }
  const fromAgent = agentCwd(agent)
  if (fromAgent) return { root: fromAgent, source: 'agent' }
  return { root: fallback, source: 'process' }
}

/**
 * The working directory an agent exposes, when the installed release has one.
 *
 * Several spellings are tried because the surface moves between releases. An absent field
 * returns null rather than a guess: falling back to the process directory happens in the
 * caller, where it can be reported.
 */
export function agentCwd(agent) {
  if (!agent || typeof agent !== 'object') return null
  const candidates = [
    agent.workingDirectory,
    agent.session?.meta?.cwd,
    agent.session?.cwd,
    agent.meta?.cwd,
    agent.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}
