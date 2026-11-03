import type { FieldValues } from '../entity-fields'
import { isFileUuid, PAGE_FILE_FIELDS, type PageFileKey } from '#shared/utils/files'
import { FILE_NAME_MAX_LENGTH, type PageFileChange } from '#shared/utils/page-files'
import { TARGET_PROPERTIES, WRITE_OUTPUT_SCHEMA } from './schemas'
import { runWrite, writeRefusal } from './write'
import type { JsonSchema, KbTool } from './types'

const UUID_LIST = { type: 'array', items: { type: 'string', format: 'uuid' } }

const FILES_DESCRIPTION = 'File UUIDs to add to and remove from the page\'s file lists, per list: '
  + '"attachments" and "images", each {add, remove, names}. A file no revision of the page holds is kept '
  + 'only if the agent owner owns it: their fresh upload, or a permanent file they may still download. '
  + '"names" maps a file UUID on the list to its name on this page, at most 255 characters; an empty '
  + 'name shows the file\'s own again. The file itself keeps its name.'

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
    description:
      "Update frontmatter fields of a knowledge-base page's draft. Only the "
      + 'fields you pass are touched; the body is left alone. The edit is applied '
      + "inside the page's collaborative editing session, so a human with the "
      + 'page open sees it arrive live. It does not publish — read it back with '
      + 'getPageForEditing. `files` adds file UUIDs to and removes them from the '
      + 'page\'s file lists (attachments, images) and names them on this page; '
      + 'files you do not name stay.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        // The shapes Drupal accepts, tracking the `frontmatter` form display.
        fields: { ...contract, description: 'Field keys to write, with their new values.' },
        files: {
          type: 'object',
          description: FILES_DESCRIPTION,
          properties: Object.fromEntries(Object.keys(PAGE_FILE_FIELDS).map(key => [key, {
            type: 'object',
            properties: {
              add: UUID_LIST,
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
      return runWrite(event, args, {
        fields: fields as FieldValues,
        ...(Object.keys(files).length > 0 ? { files } : {}),
      })
    },
  }
}
