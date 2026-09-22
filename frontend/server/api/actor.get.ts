import { defineEventHandler } from 'h3'
import { resolveActor } from '../utils/actor'

/**
 * GET /api/actor  →  { type, uid, name, via }  — the session's acting identity.
 *
 * Superset of /api/me: adds `via`, the agent client's label for an agent
 * session ("Claude") that /api/me does not carry. The collab provenance
 * tracker keys per-block contributions on `{uid, via}`, so a human and the
 * same human acting through an agent record as separate contributors. Awareness
 * publishes `via` from here too, so peers see "fago via claude".
 *
 * Resolution is delegated to the shared actor resolver (server/utils/actor.ts):
 * a Bearer agent token wins over a session cookie, and an unauthenticated
 * request resolves to the anonymous actor rather than erroring.
 */
export default defineEventHandler(async (event) => {
  const actor = await resolveActor(event)
  return { type: actor.type, uid: actor.uid, name: actor.name, via: actor.via }
})
