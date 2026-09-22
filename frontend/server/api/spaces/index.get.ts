import { defineEventHandler } from 'h3'
import { listSpaces } from '../../utils/spaces'

/**
 * Lists KB spaces.
 *
 *   GET /api/spaces  →  [ { id, internalId, name, slug, description,
 *                           outline, canManage, canWrite }, … ]
 *
 * Complements `/api/kb`, which only knows the spaces its pages reference:
 * this is the full set, so an empty space still has a landing page.
 *
 * `outline` is the space's stored page tree; `canManage` and `canWrite` are the
 * access answers the chrome decides its controls from. A manager rearranges any
 * tree; a writer creates pages, and rearranges one where the space runs no
 * review (`canRestructure`). The chrome needs all of it for every space at
 * once, and asking per space would be a request per group.
 */
export default defineEventHandler(event => listSpaces(event, { withAccess: true }))
