/**
 * Answering permission prompts by rule, and deferring everything else.
 *
 * The Python runtime's `ding approve` existed because the ACP app forwards each
 * `approval/request` to whoever holds the connection, so a human could answer from a terminal.
 * In-process there is no such waiting point: the harness's own approval panel already asks the
 * user, and a plugin that answered ahead of it would remove that decision from them.
 *
 * So this is a policy seam, not a replacement:
 *
 * - a tool named in `[approval] allow` is answered `allowed-once`, which is what makes an
 *   unattended kitchen able to run the tools it was configured for;
 * - everything else calls `next()`, which hands the question to the browser panel;
 * - without configuration nothing is answered, so installing this plugin changes no permission
 *   behaviour at all.
 *
 * The vocabulary is fixed — `allowed-once`, `rejected`, `cancelled`, `unavailable` — and the
 * service normalizes anything else to `unavailable`, which fails closed.
 */

/**
 * Register the answerer when the repository configured one.
 *
 * The policy is read when a request arrives rather than at mount time: one harness process
 * serves many repositories, and each has its own configuration.
 */
export function registerApprovalAnswerer(ctx, { resolveConfig, debug = false } = {}) {
  const log = debug ? (...parts) => console.error('[dkitchen]', ...parts) : () => {}

  ctx.on('approval/request', (request, next) => {
    let policy
    try {
      policy = approvalPolicy(resolveConfig(process.cwd()))
    } catch {
      // A repository with no readable configuration has no policy to apply, so the question
      // stays with the user.
      return next()
    }
    if (policy.allow.length === 0 && policy.reject.length === 0) return next()

    const tool = String(request?.toolName ?? '')
    if (matchesAny(tool, policy.allow)) {
      log('allowing by policy:', tool)
      return 'allowed-once'
    }
    if (matchesAny(tool, policy.reject)) {
      log('rejecting by policy:', tool)
      return 'rejected'
    }
    return next()
  })
  log('approval answerer registered')
}

/** Read the policy a configuration carries, defaulting to answering nothing. */
export function approvalPolicy(config) {
  const section = config?.approval ?? {}
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  return { allow: list(section.allow), reject: list(section.reject) }
}

/**
 * Whether a tool name matches one policy entry.
 *
 * An entry ending in `*` is a prefix match, which is how a whole plugin's tools are allowed
 * without listing each one. Anything else must match exactly: a partial match would allow a
 * tool nobody named.
 */
export function matchesAny(tool, patterns) {
  return patterns.some((pattern) => (
    pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern
  ))
}
