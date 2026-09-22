# ADR 0016: An agent holds no administrative bypass

Status: accepted (fago, 18.09.2026); pinned by
[OKB-289](https://drunomics.youtrack.cloud/issue/OKB-289)

## Context

- A bearer token acts as one human, and its permissions are *that
  account ∩ the token's scopes*, recomputed on every request
  (`docs/agent-access.md`).
- No agent scope names `bypass node access`. The shipped ceiling is
  `agent:read` + `agent:write` and their children, each naming the
  permissions an agent needs to read and write a page it has a seat
  for.
- Space access is node access: the `openkb_space_access` grants realm
  answers from the space's roster and its read access
  (`docs/space-access.md`). `bypass node access` skips that realm
  entirely, which is why a browser session as an administrator reads
  every space.
- An account holding the bypass therefore reads two different sites
  depending on the carrier: every space through a session cookie, only
  the rosters it sits on through a token.
- `openkb_agent` refuses uid 1 and any admin role as a client *owner*
  outright (`docs/agent-access.md`). That gate covers the accounts it
  can name; this ADR covers the permission itself, which any role may
  carry.

## Decision

**An admin's agent does not have admin permission. Agents work with the
regular permissions of a regular user, based on the spaces' access
control.**

- An agent's access is its owner's roster seats plus the space's read
  access. Nothing about the owner's roles widens it.
- No agent scope names `bypass node access`, now or later.
- An account that wants agent access to a space joins that space's
  roster. Administering the site is not a way in.

## Consequences

- `CeRevisionReadAccessTest` carries the agent token for the seat holding
  `bypass node access` and expects the outsider profile — 404 on every
  read of a members-only space that seat sits on no roster of. Those rows
  are the test of this ADR.
- An MCP or tool read that answers "not found" where the same person's
  browser shows the page is this decision, not a defect in the read
  path. `docs/agent-access.md` says so, and `getPageForEditing` refuses
  such a read with the seat it would take, not an HTTP status.
- The agent ceiling stays a cap only: it never adds a permission the
  account lacks, and adding one that bypasses node access would void it.
