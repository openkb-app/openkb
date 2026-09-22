import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { findSpaceBySlug, writeSpace, type SpaceSettings } from '../../utils/spaces'
import type { KbSpaceReadAccess } from '#shared/utils/kb-spaces'

/**
 * Writes a space's roster, description and policy settings.
 *
 *   PATCH /api/spaces/<slug>  { managers?: [uuid, …], members?: [uuid, …],
 *                               viewers?: [uuid, …], description?: string,
 *                               readAccess?: 'members_only' | 'all_users',
 *                               moderation?: boolean }
 *      →  the space as it now stands (same shape as the GET)
 *
 * The roster lists are sent whole — the members form always holds the full
 * roster — while the settings dialog sends the fields it edits. Drupal's
 * term update access decides whether the write lands (403 otherwise, forwarded
 * as-is).
 */
interface SpaceBody {
  managers?: unknown
  members?: unknown
  viewers?: unknown
  description?: unknown
  readAccess?: unknown
  moderation?: unknown
}

const READ_ACCESS: KbSpaceReadAccess[] = ['members_only', 'all_users']

function userIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) {
    throw createError({ statusCode: 400, statusMessage: `${field} must be an array of user UUIDs` })
  }
  return [...new Set(value as string[])]
}

function description(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'description must be a string' })
  }
  return value.trim()
}

function readAccess(value: unknown): KbSpaceReadAccess | undefined {
  if (value === undefined) return undefined
  if (!READ_ACCESS.includes(value as KbSpaceReadAccess)) {
    throw createError({ statusCode: 400, statusMessage: `readAccess must be one of ${READ_ACCESS.join(', ')}` })
  }
  return value as KbSpaceReadAccess
}

function moderation(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'moderation must be a boolean' })
  }
  return value
}

export default defineEventHandler(async (event) => {
  const slug = String(getRouterParam(event, 'space') ?? '')
  const body = await readBody<SpaceBody>(event)
  const settings: SpaceSettings = {
    managers: userIds(body?.managers, 'managers'),
    members: userIds(body?.members, 'members'),
    viewers: userIds(body?.viewers, 'viewers'),
    description: description(body?.description),
    readAccess: readAccess(body?.readAccess),
    moderation: moderation(body?.moderation),
  }
  if (settings.managers === undefined && settings.members === undefined
    && settings.viewers === undefined && settings.description === undefined
    && settings.readAccess === undefined && settings.moderation === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to change' })
  }

  const space = await findSpaceBySlug(event, slug)
  if (!space) throw createError({ statusCode: 404, statusMessage: 'Space not found' })

  return writeSpace(event, space.id, settings)
})
