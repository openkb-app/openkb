# ADR 0008: The collab snapshot store is coupled to the database

Status: accepted (fago, 18.08.2026)

## Context

The collab server's SQLite store holds working copies (and their
accounting, ADR 0005) keyed by node id. Node ids are meaningful only
within one database: a database reinstalled or restored from backup
under a store that was not makes ids mean different pages.

## Decision

Environments keep the two coherent — the code does not defend against
skew. Reinstalling or restoring the database wipes (or restores) the
snapshot store with it; `scripts/site-install.sh` does so on every
install. A backup that includes the database includes the store or
accepts losing the un-checkpointed working copies.

## Consequences

- No ownership stamps, retirement identity checks, or cross-database
  reconciliation in the collab server.
- CI workspaces reinstall the database via the same script and start
  with a fresh store by construction.
