import type { FieldValues } from '../entity-fields'
import { isFileUuid, PAGE_FILE_FIELDS, type PageFileKey } from '#shared/utils/files'
import { FILE_NAME_MAX_LENGTH, type PageFileChange } from '#shared/utils/page-files'
import { TARGET_PROPERTIES, WRITE_OUTPUT_SCHEMA } from './schemas'
import { runWrite, writeRefusal } from './write'
import type { JsonSchema, KbTool } from './types'

const UUID_LIST = { type: 'array', items: { type: 'string', format: 'uuid' } }

/**
 * Files one list may add per call.
 *
 * Each one is looked up in Drupal before the write.
 */
const MAX_ADDED_FILES = 50

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileChange(change: unknown): change is PageFileChange {
  if (!isObject(change)) return false
  return Object.entries(change).every(([op, value]) => op === 'names'
    ? isObject(value) && Object.entries(value).every(([uuid, name]) => isFileUuid(uuid) && typeof name === 'string')
    : (op === 'add' || op === 'remove') && Array.isArray(value) && value.every(isFileUuid))
}

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
    manifestName: 'update_fields',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        // The shapes Drupal accepts, tracking the `frontmatter` form display.
        fields: contract,
        files: {
          type: 'object',
          properties: Object.fromEntries(Object.keys(PAGE_FILE_FIELDS).map(key => [key, {
            type: 'object',
            properties: {
              add: { ...UUID_LIST, maxItems: MAX_ADDED_FILES },
              remove: UUID_LIST,
              names: { type: 'object', additionalProperties: { type: 'string', maxLength: FILE_NAME_MAX_LENGTH } },
            },
            additionalProperties: false,
          }])),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    outputSchema: WRITE_OUTPUT_SCHEMA,
    async run(args, { event }) {
      const fields = args.fields ?? {}
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        return writeRefusal('updateFields requires a "fields" object.')
      }
      const files = (args.files ?? {}) as Partial<Record<PageFileKey, PageFileChange>>
      const bad = Object.entries(files).filter(([key, change]) =>
        !Object.hasOwn(PAGE_FILE_FIELDS, key) || !isFileChange(change))
      if (bad.length > 0) {
        return writeRefusal('"files" takes "add" and "remove" lists of file UUIDs and a "names" map.', Object.fromEntries(bad.map(([key]) => [key, ['Not "add" / "remove" lists of file UUIDs and a "names" map of file UUIDs to names.']])))
      }
      const long = Object.entries(files).filter(([, change]) =>
        Object.values(change.names ?? {}).some(name => Array.from(name).length > FILE_NAME_MAX_LENGTH))
      if (long.length > 0) {
        return writeRefusal(`A file name is at most ${FILE_NAME_MAX_LENGTH} characters.`, Object.fromEntries(long.map(([key]) => [key, [`A name in "names" is longer than ${FILE_NAME_MAX_LENGTH} characters.`]])))
      }
      const many = Object.entries(files).filter(([, change]) =>
        (change.add?.length ?? 0) > MAX_ADDED_FILES)
      if (many.length > 0) {
        const message = `One call adds at most ${MAX_ADDED_FILES} files per list.`
        const perList = [`"add" holds more than ${MAX_ADDED_FILES} files.`]
        const errors = Object.fromEntries(many.map(([key]) => [key, perList]))
        return writeRefusal(message, errors)
      }
      return runWrite(event, args, {
        fields: fields as FieldValues,
        ...(Object.keys(files).length > 0 ? { files } : {}),
      })
    },
  }
}
