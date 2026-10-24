/**
 * The kitchen's station defaults, as live plugin configuration.
 *
 * `[models.<station>]` in a repository's `.dkitchen.toml` is per repository, and that is the
 * right place for a route that belongs to one project. But every kitchen starts from somewhere,
 * and editing a TOML file by hand to say "the verifier runs on a cheaper model" is a poor first
 * experience. So the bundle also carries one default per station as its own configuration.
 *
 * Those fields are `volatile()`, which is what makes harness render them as a form on the
 * plugin's page in Settings without this bundle shipping any client code: the Settings service
 * reads a volatile field, builds the control for its type, and writes the change back into the
 * active profile's patch. A change applies to the next session created — `apply()` reads the
 * live reference per call, and a session takes its route when it is opened.
 *
 * Precedence, from strongest to weakest:
 *
 *   1. `provider`/`model` passed to `dkitchen_new_session` for that one call;
 *   2. `[models.<station>]` in the repository's `.dkitchen.toml`;
 *   3. the station default here;
 *   4. `[harness] default_provider`/`default_model` in the repository's file.
 *
 * A repository that never configures a station therefore inherits the bundle default rather
 * than a hard-coded guess, and a repository that does stays in control of its own routes.
 */

/** The stations a default can be set for, in the order the rules mention them. */
export const STATIONS = ['orchestrator', 'designer', 'verifier', 'executor']

/**
 * The field name a station's model is stored under.
 *
 * The profile patch is YAML, so the key has to be a plain name; the station list is fixed, so
 * one flat field per station keeps the generated form readable instead of nesting a table per
 * station that a form control cannot edit.
 */
export function fieldFor(station) {
  return `${station}Model`
}

/**
 * Read one station's default route from the plugin configuration.
 *
 * Accepts either `provider/model`, which is what the form writes, or a bare `model` against
 * whatever provider the form's sibling field names. An empty or missing value means "no
 * default", and the caller falls through to the repository's own settings.
 *
 * The value may be a plain string or the live reference the harness hands a plugin whose field
 * is `volatile()`. Both reach here: Settings reads a reference, a test or a pinned profile
 * supplies a string, and the caller must not care which. A reference is dereferenced here so
 * that every caller gets the same answer.
 */
export function defaultRoute(config, station) {
  const raw = config && config[fieldFor(station)]
  const value = typeof raw?.get === 'function' ? raw.get() : raw
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  const slash = text.indexOf('/')
  if (slash > 0 && slash < text.length - 1) {
    const provider = text.slice(0, slash).trim()
    const model = text.slice(slash + 1).trim()
    if (provider && model) return { provider, model }
  }
  // A bare model id is enough for the common case: the route keeps the repository's provider
  // and changes only the model, which is what "run the verifier on something cheaper" means.
  return { provider: null, model: text }
}

/** Every station that has a default, as `{station: {provider, model}}`. */
export function defaults(config) {
  const found = {}
  for (const station of STATIONS) {
    const route = defaultRoute(config, station)
    if (route) found[station] = route
  }
  return found
}
