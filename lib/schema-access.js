/**
 * The one place dkitchen touches the harness's configuration schema library.
 *
 * `@deepseek-ai/schemastery` resolves from the harness installation, not from this package: the
 * bundle declares it as a peer so the running harness supplies it. That means a plain
 * `node --test` cannot import it, and `index.js` — which must export `Config` for the Loader —
 * would be untestable without a harness.
 *
 * So the import lives here, behind an indirection the tests can replace, exactly as
 * `registry-access.js` does for the tool registry. The schema's own contents are still real:
 * only the library that builds them is substituted.
 */

/** The harness's schema library, or a stand-in when the peer cannot be resolved. */
export let z = null

try {
  const schemastery = await import('@deepseek-ai/schemastery')
  z = schemastery.default
} catch {
  z = null
}

/**
 * Replace the schema library for a test.
 *
 * The stand-in needs whatever the declaration under test uses: `.object`, `.string`, `.boolean`,
 * `.default`, `.volatile`, `.description`. A test that asserts the *shape* of `Config` supplies
 * a recorder; one that only mounts the plugin supplies a permissive chainable stub.
 */
export function useSchema(fn) {
  z = fn
}

/** Whether the real schema library is available in this process. */
export function hasSchema() {
  return z !== null && typeof z === 'object'
}
