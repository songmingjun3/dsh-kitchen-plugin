/**
 * The bundle's own configuration, and the settings form a user edits.
 *
 * Each `*Model` field is a station's default route, written as `provider/model` or as a bare
 * model id. They are `volatile()`, which is what makes Settings render them as editable fields
 * on this plugin's page: the Settings service builds the control from the declared type and
 * writes the change into the active profile's patch, with no client code shipped here.
 *
 * `debug` stays a plain field: it is a diagnostic switch a person sets once while chasing a
 * registration failure, not something to put a control in front of.
 *
 * The schema lives in its own module rather than in `index.js` so that the precedence rules in
 * `lib/station-defaults.js` can be tested without the harness: importing `index.js` pulls in
 * `@deepseek-ai/schemastery`, which is a peer dependency and absent from a bare checkout.
 */
import { z, useSchema } from './schema-access.js'

/** Every station field the settings form edits, in the order the rules mention them. */
export const MODEL_FIELDS = [
  'orchestratorModel',
  'designerModel',
  'verifierModel',
  'executorModel',
]

const DESCRIPTIONS = {
  orchestratorModel: 'Default model for orchestrator sessions, as provider/model or a bare model id.',
  designerModel: 'Default model for designer sessions, as provider/model or a bare model id.',
  verifierModel: 'Default model for verifier sessions, as provider/model or a bare model id.',
  executorModel: 'Default model for executor sessions, as provider/model or a bare model id.',
}

/**
 * Build the configuration schema from whatever library is available.
 *
 * A function rather than a module-level constant because a test may substitute the library
 * before asking: `useSchema(fake)` then `buildConfig()` yields a schema built from the fake,
 * which is how the declaration itself is checked without the harness.
 */
export function buildConfig(zod = z) {
  if (!zod) {
    // No schema library: the Loader validates nothing and the fields stay plain strings. The
    // plugin still works; only the generated form in Settings is missing.
    return undefined
  }
  const fields = {}
  for (const field of MODEL_FIELDS) {
    fields[field] = zod.string().default('').volatile().description(DESCRIPTIONS[field])
  }
  // Empty means "no default", so a repository's own `[models.<station>]` (or its `[harness]`
  // route) decides. A field left blank is not a route to nowhere.
  return zod.object({
    // A diagnostic switch a person sets once while chasing a registration failure; not
    // something to put a control in front of, so it is a plain field rather than a volatile one.
    debug: zod.boolean().default(false),
    ...fields,
  })
}

/** The schema the Loader exports and Settings reads. */
export const Config = buildConfig()

export { useSchema }


