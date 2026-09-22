import type { FieldValues } from '../entity-fields'
import { TARGET_PROPERTIES, WRITE_OUTPUT_SCHEMA } from './schemas'
import { runWrite, writeRefusal } from './write'
import type { JsonSchema, KbTool } from './types'

/**
 * Writes frontmatter fields into the page's live editing session.
 *
 * What it accepts is the exposure contract itself (`GET /openkb/schema`), so
 * placing or removing a field in the `frontmatter` form display moves this
 * tool's input with no field list here.
 */
export function updateFieldsTool(frontmatterSchema: JsonSchema): KbTool {
  // The exposure contract, open to extras: its keys are the site's, not this
  // tool's, and an unknown one is answered per field by the write itself —
  // the structured answer an agent acts on — rather than refused as an
  // undeclared argument.
  const { additionalProperties: _closed, ...contract } = frontmatterSchema
  return {
    name: 'updateFields',
    description:
      "Update frontmatter fields of a knowledge-base page's draft. Only the "
      + 'fields you pass are touched; the body is left alone. The edit is applied '
      + "inside the page's collaborative editing session, so a human with the "
      + 'page open sees it arrive live. It does not publish — read it back with '
      + 'getPageForEditing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        // The shapes Drupal accepts, tracking the `frontmatter` form display.
        fields: { ...contract, description: 'Field keys to write, with their new values.' },
      },
      required: ['fields'],
      additionalProperties: false,
    },
    outputSchema: WRITE_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const fields = args.fields
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        return writeRefusal('updateFields requires a "fields" object.')
      }
      return runWrite(event, args, { fields: fields as FieldValues })
    },
  }
}
