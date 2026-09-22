# Connect by URL: the lifecycle

What happens between pasting the MCP URL into a client and that client being
listed on somebody's profile. The setup itself is
[Agent access](agent-access.md#connect-by-url); this is the shape underneath
it — a client that nobody provisioned, registered by software, ending up owned
by the person who connected it.

## Four steps

1. **The client registers itself.** Machine to machine, RFC 7591 (`POST
   /register`), no browser and no session: the registrant is client software,
   and no human is involved yet. What it gets is a consumer that is public (no
   secret) with PKCE required, labelled `<name> (unverified)`, marked personal
   — and **unowned**.
2. **The browser leg.** The user logs in at `/oauth/authorize`, names the
   agent and consents. The authorization code that comes back carries *them*:
   an authorization is always somebody's.
3. **The claim.** Allowing saves the name they set or let stand as the
   consumer's label — a human has now vouched for it, so the `(unverified)`
   marking goes. The first token issued for a personal, unowned consumer then
   stamps its authorizing user as the consumer's owner. One-shot — an owned
   consumer is never re-owned, and nothing puts one back into the unowned
   state.
4. **Owned.** The client lists under its owner's
   `/user/<uid>/api-clients` with **Revoke**, exactly like a client they
   provisioned by hand.

## Why registration is anonymous

There is no human in the flow until the authorize step, so there is nobody to
bind the client to at registration time. A user id asserted in the
registration payload would be self-asserted like the client name is — which is
what the `(unverified)` marking exists to refuse. The first consent is the
earliest binding the site can actually vouch for, so that is where ownership
is taken.

The credentialed alternative — registration behind a credential, a client
provisioned before it is used — is the [personal token](agent-tokens.md) path.
Connect by URL exists precisely to need no pre-provisioning.

## What ownership grants

- **Visibility and revocation**: the client appears on the owner's profile and
  can be revoked there.
- **The admin-owner gate keys on it**: an owner holding an admin role has the
  client's tokens refused, and since a client has one owner, an administrator
  consenting first refuses it for everyone. Connect by URL is an editor path.

It does **not** grant identity. Every token acts as whoever authorized *that*
flow, PKCE-bound, with permissions recomputed per request — the owner is who
manages the client, not who its tokens act as.

## The unowned window is inert

Between step 1 and step 3 the consumer lists on no profile, holds no tokens
(none can exist before an authorization), and keeps no secret. There is
nothing to take and nothing it can do.

## Where the limits are stated

- Scopes beyond the site ceiling are refused **at registration**; scopes
  beyond the consumer's own registered set are refused **at the token
  endpoint**. Neither is narrowed silently.
- The scope table and the ceiling's config home are in
  [Agent access](agent-access.md#scopes).
