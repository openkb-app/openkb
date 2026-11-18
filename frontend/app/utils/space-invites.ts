/**
 * Invites by email onto a space's roster, read and written as Drupal's
 * `openkb_invite` JSON:API resource through the generic forward (ADR 0011).
 *
 * Drupal decides: the `invite users` permission, managing the space, the role,
 * the hourly limit. A refusal arrives as the forward passes it on. An invitee
 * joins the roster only by accepting; until then nothing names them.
 */
import { SPACE_TYPE, type KbSpaceDetail, type KbSpaceRole } from '#shared/utils/kb-spaces'

const INVITES_URL = '/api/drupal/jsonapi/openkb_invite/openkb_invite'

const INVITE_TYPE = 'openkb_invite--openkb_invite'

const JSON_API = 'application/vnd.api+json'

/** An invite not accepted yet, as the members form lists it. */
export interface KbPendingInvite {
  id: string
  /** The invited email; only its inviter reads it. */
  mail: string | null
  role: KbSpaceRole
}

/** The parts of an invite resource the members form reads. */
interface InviteResource {
  id: string
  attributes: { mail?: string | null, role: KbSpaceRole }
}

/** Loads the space's pending invites, newest first; the newest 50. */
export async function loadSpacePendingInvites(space: KbSpaceDetail): Promise<KbPendingInvite[]> {
  const query = new URLSearchParams({
    'filter[space.meta.drupal_internal__target_id]': String(space.internalId),
    'filter[pending][condition][path]': 'accepted',
    'filter[pending][condition][operator]': 'IS NULL',
    [`fields[${INVITE_TYPE}]`]: 'mail,role',
    'sort': '-created',
  })
  const { data } = await $fetch<{ data: InviteResource[] }>(`${INVITES_URL}?${query}`, { headers: { Accept: JSON_API } })
  return data.map(invite => ({ id: invite.id, mail: invite.attributes.mail ?? null, role: invite.attributes.role }))
}

/** Invites the email onto the space's roster with the role. */
export async function inviteToSpaceByEmail(space: KbSpaceDetail, email: string, role: KbSpaceRole): Promise<void> {
  await csrfFetch(INVITES_URL, {
    method: 'POST',
    headers: { 'Content-Type': JSON_API, 'Accept': JSON_API },
    body: {
      data: {
        type: INVITE_TYPE,
        attributes: { mail: email, role },
        relationships: { space: { data: { type: SPACE_TYPE, id: space.id } } },
      },
    },
  })
}
