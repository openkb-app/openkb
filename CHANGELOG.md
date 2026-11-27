# Changelog

## [1.0.0-beta5](https://github.com/openkb-app/openkb/compare/v1.0.0-beta4...v1.0.0-beta5) - 2026-11-27

### Features

- Invite users by email from a space's members form ([5fb07df](https://github.com/openkb-app/openkb/commit/5fb07df14de50d179398a135f89a93ba8a2101f8))
- A component's stored props reach the search index; @notIndexed opts one out. ([3dbbc94](https://github.com/openkb-app/openkb/commit/3dbbc94469331512cc5ed7fba070ed40139b221f))
- Make the AI assistant provide change receipts when changing content ([0d73998](https://github.com/openkb-app/openkb/commit/0d7399846559275fdfb227ff82a02db60695ab8d))
- Add a Collapsible section (::details): component ([fe7b415](https://github.com/openkb-app/openkb/commit/fe7b415b4d607569d7b61cc33bd95e86cd88bbf6))
- The quickstart is one file: docker-compose.yml carries the evaluation defaults, a .env is optional. ([d5ae50a](https://github.com/openkb-app/openkb/commit/d5ae50a11c05612f8731190212632cd764858a2d))
- /node/<nid> leads to the page path; the chat receipt links changed blocks by node id. ([6b90b6f](https://github.com/openkb-app/openkb/commit/6b90b6f74332ac472f03b693ab1034b5722161d8))
- Sign in with the email and disallow changing it (mail_login + userprotect). ([cf87066](https://github.com/openkb-app/openkb/commit/cf870664c73d44d26bf547268fe0553df9b0d93a))
- Use a model step to write the chat's lexical search query ([c38fda6](https://github.com/openkb-app/openkb/commit/c38fda6ebe07996d237ff7c1607d23e608dbca4d))
- Turn the search summary into the AI answer. ([07a8642](https://github.com/openkb-app/openkb/commit/07a864263fe61c682dbbf5a763f20fa77e18c975))
- Store comment threads in columns, mentions by uid. ([9ed0134](https://github.com/openkb-app/openkb/commit/9ed01345a6e4ef95d7df7f22326fbef4cdf66aff))
- Allow agents to upload files through a single-use URL ([64f46a9](https://github.com/openkb-app/openkb/commit/64f46a98911804dea170d85e2ca16cb0fef8c21a))
- Add site-wide upload quota (5 GB default) ([2da218f](https://github.com/openkb-app/openkb/commit/2da218f185d8e22ff4816e7f151229bedc18b50d))
- Print a page on A4 with a print stylesheet. ([128a609](https://github.com/openkb-app/openkb/commit/128a60951d2b7950e77b365c36258a480f3b594c))
- Allow setting the user name in the welcome step. ([6cf2057](https://github.com/openkb-app/openkb/commit/6cf205753fdd5fd7ae3b205c598228a68ef1cd50))
- The chat searches and reads with its tools; every source a tool answers is citable. ([1e7517d](https://github.com/openkb-app/openkb/commit/1e7517d7678e339cf1e800ff4211518289978a10))
- Chat citations name the block of a page the model read. ([92bd318](https://github.com/openkb-app/openkb/commit/92bd318f281d96b08c034487d58efc3127cf4b2d))
- Configure the MCP server instructions and every tool description in Drupal. ([e8ad429](https://github.com/openkb-app/openkb/commit/e8ad429b91c5cb5382d39e801bfa60bbdc8ff342))
- Teach agents to ask for decisions in block comments, not todo lists in the page. ([0b25fb3](https://github.com/openkb-app/openkb/commit/0b25fb39fb359d67f582a965af29d16faf1fc568))
- Agents mark text and resolve own threads. ([e03cbae](https://github.com/openkb-app/openkb/commit/e03cbae7c6ca7c898d5e00e8327a6446ae66514c))
- Provide search hits as citable source. ([9d10a05](https://github.com/openkb-app/openkb/commit/9d10a05b5e26e7aedf576290668b9d82c2d0a31d))
- Style invite and account mails in the OpenKB look. ([764307a](https://github.com/openkb-app/openkb/commit/764307aaa93ce09da77aff50c216d00a5e66c5e5))
- Download a page as one self-contained print HTML file. ([ec62a1d](https://github.com/openkb-app/openkb/commit/ec62a1de17498c938d32fa0c1d870f8b349cfd00))
- Agent access tokens last an hour, connect-by-URL logins 90 days. ([a707312](https://github.com/openkb-app/openkb/commit/a7073123d6d0a06992d5fe5c0afcd3f21f9b5c63))
- Mark the active page on the collapsed icon rail. ([45b5290](https://github.com/openkb-app/openkb/commit/45b52900cd4face5b1fc9720e753ba60623cd17e))

### Fixes

- Ensure a link's URL field opens without scrolling the text away. ([a4dcc3b](https://github.com/openkb-app/openkb/commit/a4dcc3b7e5f03c46804f0ad6389800cbaab15109))
- Stop update notification mails: installer form alter in a new openkb_update_status module, empty them on installed sites. ([4a2c091](https://github.com/openkb-app/openkb/commit/4a2c091a77d638f4c78a8fe5fae55e40a8d954e3))
- Only normalize blocks that have been edited during save; improve the review panel to list blocks without an id. ([60461e2](https://github.com/openkb-app/openkb/commit/60461e242a302b4d11692b9f4ae385b48d438d33))
- Keep visible text inside the accessible name of chrome controls. ([b8ab73e](https://github.com/openkb-app/openkb/commit/b8ab73e803bdfabbdca74483921db1f2803e292d))
- Drupal core 11.4.13 (SA-CORE-2026-017/-018); execute no PHP file but index.php and update.php. ([532a6af](https://github.com/openkb-app/openkb/commit/532a6afc78d9beb7bafdac83df72618aac556c13))
- Harden the openkb-drupal image: read-only code, no code docs served. ([e988d97](https://github.com/openkb-app/openkb/commit/e988d97b4689170cef009cd62ea78a3b776b8764))
- The search row's change date renders in the reader's locale through NuxtTime, so /search hydrates without a mismatch. ([3090806](https://github.com/openkb-app/openkb/commit/3090806d11354d59679d65ee997a3b801d3f6fe2))
- Keep empty-lines of the editor, so the read page matches. ([6358137](https://github.com/openkb-app/openkb/commit/635813753960365e00f3181933ba6f0a9d914953))
- Take the custom filename for downloads, store them sanitized ([39d0ef4](https://github.com/openkb-app/openkb/commit/39d0ef4d9a5db343b889ac965d91a3896b45ccef))
- Give a component body the size of the text around it ([ac7a4a7](https://github.com/openkb-app/openkb/commit/ac7a4a7e9d9b13d57ec7696c179ddf0c0de6d863))
- Make drupal.org's cspell job pass on the filename and invite tests. ([fb40430](https://github.com/openkb-app/openkb/commit/fb40430c74d4f64bbf53d106c8ef7f88b14e70ab))
- Stop offering a peer approval to a writer who already gave it ([60b32ea](https://github.com/openkb-app/openkb/commit/60b32ea8c994dbd6578d5544f55ea21205cb745a))
- Rank the link mark below code, so Arrow-Right leaves a linked inline code. ([46d7112](https://github.com/openkb-app/openkb/commit/46d71123513e9f16f8c418a29ac40d73a68dbd10))
- Fix offline mirrors to be per user, report changes as draft ([c515f85](https://github.com/openkb-app/openkb/commit/c515f853cd2e61d4e2dbd63eaa5f9986b86ba950))
- Move a session endpoint off the deprecated /api/mcp in a post update. ([8073ec8](https://github.com/openkb-app/openkb/commit/8073ec83f307591db54b01874f99d3e0095bfa14))
- WaitForChanges tool reports each comment change only once. ([5d7d909](https://github.com/openkb-app/openkb/commit/5d7d909838de945fa536412e706ac76e127cc0ad))
- Read shipped config through one reader, for drupal.org's pipeline. ([3f3cd87](https://github.com/openkb-app/openkb/commit/3f3cd87febd8dbd3eee9c0671a52457b40755f5a))
- Ctrl+P in edit mode with the chat open prints at page width. ([5bea4b9](https://github.com/openkb-app/openkb/commit/5bea4b9c0e7840d92f851c9de0a8d1979695c5eb))

### Improvements

- The webserver refuses core's JSON login (/user/login?_format). ([b3de30d](https://github.com/openkb-app/openkb/commit/b3de30da8d6b2ac131acec180944e36540e55ead))
- Cancel pending invitations after 24h ([2248577](https://github.com/openkb-app/openkb/commit/2248577baf63c7caa7bb9c93bce6ab2b49a048a9))
- Invite polish: one add row per list, stale rows, duplicate and invalid emails, no account without accepting. ([0d305d8](https://github.com/openkb-app/openkb/commit/0d305d8c1cafe8315ed04d4b0f812bc367b141f2))
- Better UX and error message for AI answers ([a8c4ccd](https://github.com/openkb-app/openkb/commit/a8c4ccdd57cc9469e83111c5b9a2ce8fff1b54a3))
- Serve the MCP endpoint at /mcp, deprecate /api/mcp, present the server with an icon. ([9c3f2ad](https://github.com/openkb-app/openkb/commit/9c3f2addcc28fc7d5d0e8ffb1dd7bbf585d368d6))
- Limit mcp tool to only allow own uploads ([d37c42c](https://github.com/openkb-app/openkb/commit/d37c42c9054c6c9053aa5df5bc011b9bfe975e35))
- Assistants follow the site default cleanly; drop the ai_assistant_api form patch ([86d346d](https://github.com/openkb-app/openkb/commit/86d346d9161785897ede9a82495cb7bd741cf193))
- Say when a mailed invite link is no longer valid. ([b06c92a](https://github.com/openkb-app/openkb/commit/b06c92a6c0b694209bbefc5d74faa0f9b527c5c2))

### Performance

- Load the editor and the chat on demand on read pages. ([e61bea1](https://github.com/openkb-app/openkb/commit/e61bea1b846f97a438a1da1daade16ad666293ba))

### Documentation

- Add updating the openkb.app Features page to the release steps. ([849e388](https://github.com/openkb-app/openkb/commit/849e388413e6b02d9a0ea241ee8b7e7d7059ac6a))
- Add Invitations, profile guide pages and user-management steps ([5bdb15c](https://github.com/openkb-app/openkb/commit/5bdb15c771583409764f012c06c25708c85c86ac))

## [1.0.0-beta4](https://github.com/openkb-app/openkb/compare/v1.0.0-beta3...v1.0.0-beta4) - 2026-11-17

### Features

- Rename a file per page and edit its description in the editor's attachment list. ([4ce7a79](https://github.com/openkb-app/openkb/commit/4ce7a79821cd27f5e0837d1b39881e3519d8b120))
- Rename a file from its bubble in the text, the same name as the attachment list's. ([5858045](https://github.com/openkb-app/openkb/commit/585804571e12e27ebd26239afdc223d476be9c76))
- Open each revision from the version history, and pin who sees which versions. ([af53464](https://github.com/openkb-app/openkb/commit/af53464845d40063b070d270984ed4d3fe68c626))
- Type emoji with a :shortcode menu in the page editor. ([743a0a7](https://github.com/openkb-app/openkb/commit/743a0a70e808cfc223af39dbc482158604068eae))
- Review and AI chat as collapsible sections of the editor pane; comments assigned to the chat are handled by it. ([98104b2](https://github.com/openkb-app/openkb/commit/98104b25b42c22f85de8796264488e81dac43c9e))
- One Vue component per comark component, shared by read view and editor. ([f31bb83](https://github.com/openkb-app/openkb/commit/f31bb83992c2f6ab07048449c38d7d0143c102cd))
- Approve every change that is yours on a page at once, after a confirmation, in one revision. ([f498103](https://github.com/openkb-app/openkb/commit/f4981035780feb70cc8416fea37734c1cff4469c))

### Fixes

- Build the drupal image on FrankenPHP 1.13.4. ([7465d5b](https://github.com/openkb-app/openkb/commit/7465d5b72cbf4f7fb34b5568fd1d9822e58fd11a))
- Give diagrams more space above and below than a paragraph. ([bec7968](https://github.com/openkb-app/openkb/commit/bec796865b1919f2ac48b477a98a4a45fdd6fc0c))
- Security update 2026-10-28: ai 1.5.2 (+ symfony/mime). ([67d8833](https://github.com/openkb-app/openkb/commit/67d88337e08c2ec0f7e29a0eb99acd31f97e7bb6))
- Undo an image or file insert in one step, keep typing below it, keep redo working on pages ending in a block. ([08b4176](https://github.com/openkb-app/openkb/commit/08b4176d71254588b8e21f8cae2122a9b840fbb7))
- Update nuxt to 4.6.4 and the frontend's vulnerable runtime dependencies (hono, fast-uri, qs, zod). ([2a003bd](https://github.com/openkb-app/openkb/commit/2a003bdb58d50ad8cfb0a3474403c8d21123f8cc))
- Raise the root composer floors to the locked versions. ([a15215b](https://github.com/openkb-app/openkb/commit/a15215b5e248a2d9ed6d37858cc107b4a50bbd9a))
- Security update 2026-11-04: simple_oauth 6.1.4 and Symfony 7.4.23. ([b996839](https://github.com/openkb-app/openkb/commit/b996839577491470003bdffdc16e2786a5f8d481))
- Update nuxt-component-preview to 1.1.2 and list @vercel/nft and @rollup/plugin-node-resolve as build-only. ([6087f73](https://github.com/openkb-app/openkb/commit/6087f73bb3ae90df0b43f59198db74923a8125fe))
- FrankenPHP 1.13.5, Alpine security updates in both images, no dependabot cooldown on base images, upstream security-release check in the image scan. ([27bd934](https://github.com/openkb-app/openkb/commit/27bd934f9aaa15f16e3a546d39e85e73aea6cddc))
- Fail the base-images job when the GitHub API call fails; doc wordings. ([7b81584](https://github.com/openkb-app/openkb/commit/7b81584f98251aad600dc511e7bcc94d775be275))
- Render a mention as a chip on the read page. ([11ec108](https://github.com/openkb-app/openkb/commit/11ec108c163f46b4e72b3c0c024da10a6bb734ed))
- Run block-menu actions on the live position, drop per-keystroke rebuilds, and fix two raced specs. ([5def909](https://github.com/openkb-app/openkb/commit/5def9090f1d3d5d4440bbb025bc066700a2ee8cc))
- Bump y-tiptap to 3.2.0 and cover co-editing carets and undo per feature. ([d450686](https://github.com/openkb-app/openkb/commit/d4506864ceb5060dfb51fbbdbf37c3b5ea8f2f54))
- Add FEFF to the module's cspell words, so drupal.org's cspell job passes. ([c828365](https://github.com/openkb-app/openkb/commit/c828365b61cd15e2415e4de36118cbe5f8f9a287))
- Rotate the committed dev default credentials. ([c18d7a9](https://github.com/openkb-app/openkb/commit/c18d7a99d522587a18bc506aff867dc11195049f))
- Hold the site while Drupal installs, so no request writes its hook list over the installer's. ([a0c6c87](https://github.com/openkb-app/openkb/commit/a0c6c878fa51e4aa93dc8b40412553d8b90a2aa6))
- Keep a file name typed in the page's file list when the page text changes before Enter. ([9396604](https://github.com/openkb-app/openkb/commit/93966046ea625c3f2260eaadb3065ce8365678f4))
- Focus the editor as soon as a link is applied, so keys typed right away reach the text. ([5355427](https://github.com/openkb-app/openkb/commit/5355427fa61ba3a8c496f32cc5c2afb178bcb1f5))

### Performance

- Mount the one toolbar set that fits instead of hiding the others with CSS. ([9466792](https://github.com/openkb-app/openkb/commit/94667920fd7e206e2443fe1483a43f1eee23466d))
- Keep the presence list as is while it reads the same, so a peer's keystroke re-renders no review pane. ([9d67dbf](https://github.com/openkb-app/openkb/commit/9d67dbf786d21411c259d47c1d9cebf6ec40f0b9))
- Apply peers' document updates in one transaction per 100 ms window, so the editor's work follows the window, not the number of typists. ([0ec4641](https://github.com/openkb-app/openkb/commit/0ec4641435a42eb5c8f89d91d5dbe5394f6f80f6))
- Nitro serves brotli and gzip copies of the public assets. ([c79e6ce](https://github.com/openkb-app/openkb/commit/c79e6ce6b3085e4091d9879dd9f89402f6c9ba52))
- Editor speed part 2: toolbar answers, margin controls kept in the DOM, block list without text. ([84d8d12](https://github.com/openkb-app/openkb/commit/84d8d12d2e37d40c9dc5b68215e769aad0a238c3))

### Documentation

- Mark only alphas as GitHub pre-releases, and align the release and publishing docs with sync.sh. ([370e383](https://github.com/openkb-app/openkb/commit/370e3833229eec28c2e0acbc6ffce1c3dea33300))

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


