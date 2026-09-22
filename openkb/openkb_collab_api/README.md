# OpenKB Collaboration API

The collaboration server is a service, not a person: it holds an OAuth client
of its own (ADR 0001), writes in every space, sits on no roster, and is
believed about who wrote which block. The surfaces it reaches Drupal through
live here, together with the identity that opens them.

## Contents

- `POST /openkb/node/{node}/commit` (`CommitResource`) — the checkpoint and
  `.md` write. It owns the revision base, the moderation state a commit lands
  in, and the conditional write below; the rest is core's
  `jsonapi.entity_resource`.
- `use collaboration api` — the collaboration server's way into every space,
  and the one `kb_space` permission a role grants rather than
  `openkb_space_access` calculating it. Access only: what a checkpoint is
  believed about comes from its OAuth scope.
- `GET /openkb/node/{node}/join-access` (`JoinAccessController`,
  `SessionFieldAccess`) — the join gate's whole question, answered in one
  request. See "Admission" below.
- `okb:create-oauth-consumer` — provisions the consumer and its service
  account from the environment, converging on a re-run. Driven by
  `scripts/setup-collab-oauth.sh`; the scope and the role the token is capped
  at ship in `openkb_recipe_collab`.

## The conditional write

A commit payload may name `based_on_changed`, the working copy's `changed` it
was assembled against. `CommitResource` compares it against the stored value
inside the sidecar hold and answers **409** with `{expected, actual}` in the
error's `meta`, writing nothing.

It closes the lost update the hold cannot: `BlockMetaLock` orders two writers,
it does not tell a stale one from a current one, so a session that read at T0
would otherwise carry away a T1 write it never saw. The check is on the token,
not on the caller — every write reaching `CommitResource::write()` is covered,
including the checkpoint a peer's sign-off triggers.

A payload naming no token is not checked: the moderation actions (publish, and
any other state-only write) commit a judgement about whatever the working copy
is now and read no content a concurrent write could invalidate.

`changed` counts whole seconds, so a write landing in the same second as the
revision a payload was built on is indistinguishable from it.

## Admission

Admission is write control: the Y.Doc is a shared buffer, so a field the joiner
may not edit would still be editable through the session and committed at the
next checkpoint under whoever's credentials carry it. Node update access is one
decision, field edit access another (`FieldItemList::access()`,
`hook_entity_field_access()`), and the gate needs both plus the account it is
seating — so one route answers all three.

```
GET /openkb/node/{node}/join-access
→ 200 {"account": {"uid": 7, "name": "editor1"},
       "update": true,
       "denied_fields": ["field_owner"]}
```

`denied_fields` are the session's fields — the title, `field_kb_body`, and the
frontmatter exposure contract's — this account may not edit. A non-empty list
refuses the join, whole; there is no per-field partial session. Such a refusal
is logged as a warning naming the account and the fields, the level core
records an access denial at.

`update: false` is an answer, not an error: the gate tells "signed in without
access" from "not signed in" by the account on it. Reading the node is the
floor — an account that may not is refused with a 403, and a caller that
cannot read the answer refuses the join.

The answer is one account's and carries no cacheability, so no cache layer
holds it.

## Boundary

The commit and checkpoint surface lives here. `openkb_workflow` owns the
review and moderation model this surface consumes by DI; `openkb_jsonapi`
keeps the one person action left on it, the space move; `openkb_revision`
owns the revision history.
