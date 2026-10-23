# Changelog

## [1.0.0-beta3] - 2026-10-23

### Features

- Let an agent delete a page it created and nobody else touched.
- One mcp_tool_config decides which tools agents and the chat are offered.
- Outgoing mail from MAILER_DSN and MAIL_FROM.
- Open a link from the editor in a new tab on Ctrl/Cmd+Click or a middle-click.
- Link bubble for links, page links and citations: see the target, open, change, remove.
- Highlight code fences with Shiki on the read page, in the editor and in chat answers.
- Index image alt text and title in search chunks.
- Run the AI Guardrails Prompt Safety sets on every AI call.
- Read a page's history over MCP.
- Close JSON:API to anonymous with jsonapi_role_access.
- Sign in with Drupal's login form over the CE API, drop the login proxy.
- Take the search page's filters and its listing onto the search_pages tool.
- Rewrite shipped page links into :doc references on import.
- Add page-owned attachment and image file fields.
- Upload, embed, list and download page files.
- Step 3: an image and file bubble with Replace in place.
- Chat and topic guardrails on gpt-6-luna, guardrails without reasoning.
- Retire media: no media module, dialog, passthroughs or media image embeds.
- Enable the Anthropic and Mistral AI providers with env-backed keys, like OpenAI.
- Copy a link's URL from the link bubble, and check the bubble in the dark theme too.
- Drupal/ai 1.5.1, tool beta9, ai_provider_openai 1.3 (Responses API); reasoning per assistant.
- Let an agent upload a page file over MCP.
- Show an HTML or PDF attachment in the page with ::embed.
- Resize an image in the editor, width stored in the ::image fence.
- Paste an image into the editor as a page image; open read-page images large.
- Render mermaid fences as Pele diagrams, as the first pluggable fence component.
- Drop any file on the editor: an image becomes an image, any other file a file card.
- Hide an attachment from the read page's list with core's per-file display flag; an embedded HTML/PDF file is hidden by default.

### Fixes

- The install-state build installs the site alone.
- Open the Turn into submenu by tap in the phone-width block menu spec.
- Untrack settings.local.php, ship an example instead.
- Harden checkpoint identity, revision history, statesOnly, page titles and space record fields.
- Refuse chat turns in roles a client may not speak in.
- Refuse consent on another account's self-registered client.
- Refuse moving a page into a space the mover may only read.
- Keep the read view while the collab server is unreachable, release timers, docs and server caches.
- Leave a deleted page for its parent page, else its space landing.
- Parse stored documents without comark's streaming auto-close.
- Recalculate space access when an account's roles or a role's permissions change.
- Only follow a same-origin login destination.
- Drop the unused CI basic-auth gate and its password in the console, add an anonymous sweep.
- File inline comments under the account that wrote them.
- Build every Drupal passthrough from its router param and refuse dot segments.
- Filter kb_chunks on the space id, and re-track every page of a renamed space.
- Keep the setup page up on a database no install finished on.
- Share one agent session start across parallel first calls, close a displaced session.
- Release editor DOM listeners without touching a destroyed editor's view.
- Frame retrieved sources and tool results as quoted material, close the JSON:API user resource to anonymous.
- Stub useKbOutline in the useKbNodeEditSession test.
- Keep a page queued for indexing while the comark sidecar is unreachable.
- Replace the corrupt e2e fixture PNG.
- Leave the inline comments API to the collab server.
- Parse a finished chat or summary answer without comark's streaming repair.
- Forward X-Forwarded-For on the CE form relay, so Drupal's login flood keys on the client.
- Refuse cross-site cookie writes and collab handshakes, require the CSRF token on the chat route.
- Keep a CE destination redirect relative in lupus_ce_renderer.
- Make the drupal.org package pipeline pass on its own composer.json and MySQL.
- Bound the retrieval query under OpenSearch's clause limit.
- Read the authenticated role's grants from install-state where the tree has it.
- Keep a code block's margin marks out of its text, so typing keeps the caret.
- Smaller rows in the picker's "My files" list.
- Interim PHP mitigations: no session upload progress, no memory limit, request bodies capped at 32M.
- Write no trailing whitespace a textblock reads back without, so a Save never leaves a block changed by nobody.
- Offer the search summary read tools only.
- Name an image or file block by its label in the comment composer.
- Open a file card's download in a new tab, so the editor stays.
- Let page file writes follow page access, and check who added a reattached file.
- Agent editing mark in the pending colour, cleared after the write and while the agent waits.
- Build on FrankenPHP with PHP 8.3.36 and drop the temporary memory and request body limits.
- Require the Anthropic and Mistral providers for development, so the drupal.org pipeline installs them.
- Tint a commented passage inside a list item or quote.
- Require the Anthropic and Mistral providers for development, so the drupal.org pipeline installs them.
- Teach cspell the non-ASCII file name PageFileAccessTest uploads.
- Update simple_oauth to 6.1.3 (SA-CONTRIB-2026-242) and drop the / patches it supersedes.
- Open the mounted comment-marks cases' thread with a comment draft.
- Follow a published rename to the new path, and hydrate the recent changes on the server's clock.
- Keep page files out of an agent's own checkpoint.
- Read an entity's cache tag checksum before loading it, so a read overtaken by a publish is not cached as current.
- Send MCP tool descriptions as plain text, and name the agent in list_revisions.
- Use US spelling: sanitizing, and say so in CLAUDE.md, for drupal.org's cspell job.
- Tokenize code fences without Shiki's time limit, so a busy host colours them the same.
- Re-patch a built tree when patches.lock.json changes, so the plain-text tool description patch reaches CI.
- List only the revisions a reader may see on Drupal's own revision overview.
- Keep a caret key ProseMirror's focus timer would undo, and unflake the undo/redo and review-gate specs.
- Update the MCP SDK to 1.32, linkify-it to 5.0.2 and markdown-it to 14.3.3; follow the node:22-alpine digest daily.
- Update seroval, shell-quote, proxy-addr, hono, vite, launch-editor and the e2e deps.
- Update drush, trash, rest_menu_items, commonmark, ai_provider_amazeeio and core-dev.
- Ship the frontend image without npm and without a world-writable node_modules
- Let Home reach a block's start in Firefox, where the caret lands inside the block's margin control.
- Show the editor as live only once it synced; time out the collab server's Drupal reads.
- Agent no longer credited with a person's duplicated block; unaccounted review holds visible and named.
- Download an HTML embed outside its frame; fix the embed buttons and the scroll on Edit.
- Keep monitoring's config in its recipe only, so the drupal.org module tests pass.
- Show a change naming no writer in the review pane, in a space not enforcing its step.

### Improvements

- Harden the stack: proxy headers, no basic_auth, no test modules in production, TLS overlay shipped.
- Configure ai_rag_cite's prompt texts per assistant, keep OpenKB's wording in openkb_ai.
- Sync the three published repositories with one command, one commit per dev commit.
- Pass .env whole to the drupal and cron containers; no per-key compose entries.
- Ignore status report warnings the running site cannot fix in monitoring.

### Performance

- Find a caller's assigned comment threads through an indexed assignee_uid column.
- Cache Drupal's CSRF token per session, check only routes Drupal does not.

### Documentation

- State that a space's managers enable and disable it.
- Re-index the architecture diagram's linkStyle to its 19 links.

## [1.0.0-beta2] - 2026-09-30

### Fixes

- The quickstart OpenSearch ignores the disk watermarks, so a nearly full host disk leaves the indexes writable.
- Demo pages carry the site manager recipe their siteadmin account needs.
- Unpublished pages are readable by space editors only.
- The module tests pass cspell, phpstan and phpunit on drupal.org.

### Improvements

- The sync scripts start from the published branch head, push with --push, and name the missing module sync.

## [1.0.0-beta1] - 2026-09-23

## [1.0.0-alpha3] - 2026-09-23

### Fixes

- Start the cron service after drupal, so one container fills the files volume.
- A keyless install finishes: the chunk re-feed needs a key.

## [1.0.0-alpha3] - 2026-09-23

### Fixes

- Start the cron service after drupal, so one container fills the files volume.

## [1.0.0-alpha3] - 2026-09-23

## [1.0.0-alpha2] - 2026-09-23

### Features

- Run Drupal cron from a cron service with supercronic, not automated_cron.
- Auto-install on first boot, a holding page until ready, and update.php once after an image update.
- The user guide ships its first screenshot.

### Fixes

- Make the drupal.org pipeline of project/openkb green.
- The update hold stops making the site uncacheable, and a boot never installs over a database.

### Documentation

- The public README carries requirements, installation, AI setup and updates.

## [1.0.0-alpha1] - 2026-09-23


