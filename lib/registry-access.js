/**
 * The one place dkitchen touches the harness's tool registry.
 *
 * `@deepseek-ai/dsh-tools` resolves from the harness installation, not from this package:
 * the bundle declares it as a peer so the running harness supplies it. That means a plain
 * `node --test` cannot import it, and every file that registered tools would need a harness
 * to be tested at all.
 *
 * So the import lives here, behind an indirection the tests can replace. Everything else —
 * the schemas, the descriptions, the execute bodies — is testable without one.
 */

/** The registry's `defineTool`, or a stand-in when the real one cannot be resolved. */
export let defineTool

try {
  // Top-level await is available in this module system; a missing peer only disables the
  // registry, it does not break the plugin's loading.
  const tools = await import('@deepseek-ai/dsh-tools')
  defineTool = tools.defineTool
} catch {
  defineTool = null
}

/**
 * Replace `defineTool` for a test.
 *
 * The stand-in returns its input unchanged: the real function validates and compiles the
 * declaration, and what the tests need to check is what dkitchen declared, not what the
 * harness did with it.
 */
export function useDefineTool(fn) {
  defineTool = fn
}

/** Whether the real registry is available in this process. */
export function hasRegistry() {
  return typeof defineTool === 'function'
}
