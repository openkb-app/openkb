import type { JsonSchema } from './types'

/** Schema fragments more than one tool declares. */

export const PATH_DESCRIPTION
  = 'The page path, e.g. "team-wiki/getting-started" — its space slug then its '
    + 'own, exactly the URL path (a leading slash, a trailing ".md" and a '
    + '"#block" anchor are tolerated). It is what tool_api__search_pages '
    + 'returns — anchored on the section it cites — and what links between '
    + 'pages use.'

/**
 * How a write tool names its target. `path` is the addressable name an agent
 * already has from `getPageForEditing`/`tool_api__search_pages`; `nid` exists
 * for a caller that resolved the node some other way.
 */
export const TARGET_PROPERTIES = {
  path: { type: 'string', description: PATH_DESCRIPTION },
  nid: { type: 'integer', description: 'Node id, as an alternative to "path".' },
} as const

/**
 * Maps every property of a schema through `map`, leaving a schema that carries
 * no `properties` object untouched.
 */
function mapProperties(
  schema: JsonSchema,
  map: (property: unknown) => unknown,
): JsonSchema {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return schema
  const mapped: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(properties)) mapped[key] = map(property)
  return { ...schema, properties: mapped }
}

/**
 * The exposure contract without its form-rendering hints.
 *
 * `x-widget` says which widget renders a field and with what settings — rows,
 * placeholder, autocomplete match limits. That is the editor form's business
 * and it is the bulk of the schema's weight, so the tool surface drops it. What
 * Drupal accepts is untouched: types, enums, cardinality and the field set all
 * still track the frontmatter form display. The editor reads the hints from
 * `GET /openkb/schema` as before.
 */
export function withoutWidgetHints(schema: JsonSchema): JsonSchema {
  return mapProperties(schema, (property) => {
    if (!property || typeof property !== 'object') return property
    const { 'x-widget': _widget, ...rest } = property as Record<string, unknown>
    return rest
  })
}

/**
 * Turns the frontmatter exposure schema (`GET /openkb/schema`) into an output
 * schema for the projection getPageForEditing returns.
 *
 * The exposure schema is an *input* contract — the shapes Drupal accepts. The
 * projection is looser: every exposed field is always present, and an empty one
 * projects as `null` (single) or `[]` (multi), so a reader can tell "exposed
 * but empty" from "not exposed". Each property is therefore widened to also
 * accept `null`, and `required` is dropped — the field set and per-field types
 * still track the form display (place/remove a field → this schema follows),
 * only the emptiness representation is admitted.
 */
export function toProjectionSchema(schema: JsonSchema): JsonSchema {
  const { required: _required, ...rest } = schema
  return mapProperties(rest, property => ({ anyOf: [property, { type: 'null' }] }))
}

/**
 * What a write tool reports.
 *
 * One schema for both outcomes, and that is deliberate: a rejected write is
 * data the caller must act on, not a transport failure, so it comes back as a
 * validated structured result (`ok: false` plus per-field `errors`) rather
 * than as prose the agent has to parse. The MCP client validates
 * `structuredContent` against this schema whether or not the result is flagged
 * as an error, so the error shape has to live in it.
 */
export const WRITE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: {
      type: 'boolean',
      description:
        'Whether your editing session took the write. The session owns '
        + 'persistence and checkpoints on its own schedule, so this is '
        + 'acceptance, not a Drupal revision. Read your work back with '
        + 'getPageForEditing, which serves the live session.',
    },
    nid: { type: 'integer' },
    entry: {
      type: 'string',
      enum: ['joined', 'started'],
      description:
        'Whether your session found a live editing session and joined it, or '
        + 'started one because nobody had the page open. It describes the '
        + 'session, which outlives this call, so later writes on it keep '
        + 'reporting what it found when it opened.',
    },
    observers: {
      type: 'integer',
      description:
        'Humans connected to the document in a browser while the write was '
        + 'applied. Never counts you, and can be zero while you are still in the '
        + 'page — an agent session outlives the humans in the room.',
    },
    applied: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string' }, description: 'Field keys actually changed.' },
        body: { type: 'boolean' },
        blocks: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Block id → the version that block holds now, for every block the '
            + 'write touched. A block you replaced is under the id you named; '
            + 'a block you inserted is under the id minted for it, which is how '
            + 'you learn it. Send one straight back as the next op\'s `expect`: '
            + 'editing what you just wrote needs no read between.',
        },
        comment: {
          type: 'object',
          description:
            'Where a commentOnBlock message landed: the thread it is in — the '
            + 'one you named, or the one opened for it — and its own id. Send '
            + 'the thread back as `threadId` to keep answering in it.',
          properties: {
            threadId: { type: 'string' },
            msgId: { type: 'string' },
          },
          required: ['threadId', 'msgId'],
          additionalProperties: false,
        },
      },
      required: ['fields', 'body'],
      additionalProperties: false,
    },
    message: { type: 'string', description: 'Why the write was refused.' },
    errors: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
      description: 'Per-field messages on a validation refusal. Nothing was written.',
    },
    conflicts: {
      type: 'array',
      description:
        'Ops refused because their block changed since you read it. Nothing was '
        + 'written — not even the ops that would have applied. Re-apply each '
        + 'edit to the `markdown` given here and retry with its `version` as '
        + '`expect`; no second read is needed.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Which op, by position in `blocks`.' },
          id: { type: 'string', description: 'The block it named.' },
          expected: { type: 'string', description: 'The version the op sent.' },
          version: { type: 'string', description: "The block's current version." },
          markdown: { type: 'string', description: "The block's current markdown." },
        },
        required: ['index', 'id', 'expected', 'version', 'markdown'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok'],
  additionalProperties: false,
}
