# Architecture decision records

Terse records of the decisions that shape the system — the constraint,
the call, the consequences. One file per decision, numbered. Until
beta1, a changed decision edits its ADR in place — git is the history.
From beta1 on, released ADRs are not rewritten: a change gets a new
ADR and a status line pointing to it.

| ADR | Decision |
|---|---|
| [0001](0001-collab-server-oauth-identity.md) | The collab server is a `client_credentials` OAuth client; trust is its own `collab` scope |
| [0002](0002-writer-sets-attribution.md) | A monotone writer set per block records who wrote it; set members may not approve it (admins may); a `via` entry requires the agent step |
| [0003](0003-agents-are-session-peers.md) | Agents edit as live session peers, never writing Drupal directly |
| [0004](0004-drupal-authoritative-gate-fail-closed.md) | Drupal stays in control of trust, publish, and review; unnamed changes are denied, not guessed |
| [0005](0005-single-replica-collab-server.md) | No crucial state in memory only — nothing lost on restart; one document-sharded-ready replica for now |
| [0006](0006-two-kinds-of-comments.md) | Inline review comments ride editing (live in the session, durable in own storage beside the page); document comments are core comment entities on the published page |
| [0007](0007-code-distribution-and-naming.md) | Names decide where code ships: `openkb_*` modules in the one d.o `openkb` package (all workflow code in `openkb_workflow`), `openkb_recipe_*` recipes outside it partner-only, un-prefixed contrib graduates to own projects, the frontend is a Nuxt layer (npm, MIT) |
| [0008](0008-store-coupled-to-database.md) | The collab snapshot store is coupled to the database — environments keep them coherent; the code does not defend against skew |
| [0009](0009-tool-placement.md) | Every tool is declared in Drupal as a Tool API plugin and derived to both consumers; it executes in Drupal unless it interacts with the live editing session; the MCP protocol is the wire between the runtimes; access is enforced when a tool executes, not when it is listed |
| [0010](0010-search-in-drupal.md) | One OpenSearch index, one read path: every search runs in Drupal on `kb_chunks`, space-filtered by Drupal's own authority, fail closed |
| [0011](0011-frontend-server-forwards-drupal-apis.md) | Drupal APIs reach the browser through one generic forward: allowed APIs only, JSON only, no logic; own server routes only where the frontend owns the behaviour |
| [0012](0012-every-comark-component-renders-as-a-vue-component.md) | Every comark component renders as a Vue component, the inline ones included; inline components are not blocks, and block identity stays with block-level elements |
| [0013](0013-one-typography-class-list.md) | Page typography is one class list shared by the read view and the editor; the Prose components and `@tailwindcss/typography` are not used for page prose |
| [0014](0014-wire-format-keeps-html-entities.md) | Page text keeps the serializer's HTML entities for `&`, `<`, `>` in the stored comark; every surface that serves it as source — the tools, the `.md` lanes — decodes on the way out and encodes on the way in, so a reader there never sees an entity; no override of the library |
| [0015](0015-seeded-entities-ship-as-recipes.md) | Seeded entities ship as recipe content, per-environment setup as `openkb_recipe_dev` / `openkb_recipe_ci`, deploy scripts only for environment credentials; a system-wide OAuth consumer is a plain consumer and agent-ness is read off the token's scopes |
| [0016](0016-agents-hold-no-administrative-bypass.md) | An agent holds no administrative bypass: its access is its owner's roster seats and the space's read access, and no agent scope names `bypass node access` |
| [0017](0017-every-change-carries-its-review.md) | Every difference between a draft and the published revision is a review item carrying its own sign-off — block text, block added, removed, moved, and the title; no kind of change is exempt where a step is enabled |
| [0018](0018-upstream-maintained-base-images.md) | Every own image builds directly on an upstream-maintained base pinned by digest — a Docker Official Image, the project's Verified Publisher image, or the project's own image with verified build provenance; no third-party repackaging layer |
