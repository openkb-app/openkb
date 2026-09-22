# ADR 0007: Names decide where code ships — openkb package, partner recipes, contrib graduation, frontend layer

Status: accepted (fago, 18.08.2026)

## Context

OpenKB is developed in one repo but ships as parts with different
audiences: fully open building blocks (Drupal modules, the Nuxt
frontend), a partner-only assembly layer (recipes), and a public
Docker image as the primary setup path. Placement and naming decide
what can be published where — getting them wrong turns every later
release into a refactoring. Full structure and execution: OKB-93;
upstreaming policy and tracker: OKB-95.

## Decision

- **One Drupal package, modules only.** The d.o `openkb` project
  (`drupal/openkb`) is the home of the OpenKB Drupal modules. Every
  `openkb_`-prefixed module lives below it; un-prefixed modules and
  recipes never do. There is no base `openkb` module.
- **One workflow module.** All workflow/review code — publish gate,
  sign-offs, block provenance and reviewed-by, review lanes — lives in a
  single `openkb_workflow` submodule.
- **Recipes are separate and partner-distributed.** Recipes live
  outside the package, named `openkb_recipe_<name>` with
  `openkb_recipe_main` as the site-build entry point. They ship
  through the partner channel; the shared prefix reserves room to
  publish them later as their own projects. The legacy hyphenated
  `open_kb` spelling is retired everywhere.
- **Generic code is born generic.** Reusable modules carry no
  `openkb_` prefix, live in `web/modules/custom/`, and graduate to
  their own d.o projects as a packaging step, not a rewrite
  (currently `comark`, `simple_oauth_personal_consumers`,
  `vercel_ai_sdk`; `openkb_schema` and `openkb_media_library` join
  the track when generalized under new un-prefixed names).
- **The frontend is a Nuxt layer.** The app and the embedded collab
  server distribute as a Nuxt layer (npm, MIT); consumers `extends`
  it, and customization means layer overrides — not forking the app.
- **In-tree first.** Both packages develop inside openkb-dev-project
  (composer path repository; path-based `extends`) and split into
  their own repos when stable.

## Consequences

- A name states its destiny: `openkb_*` ships in the product package,
  `openkb_recipe_*` ships to partners, un-prefixed ships to d.o —
  publishing later is packaging, never renaming under consumers.
- The Docker image stays the public setup path: recipes applied, not
  included; every building block in it is itself open.
- Restructuring toward this layout must be behavior-neutral — full
  suites green per step is the gate.
- Two license regimes coexist: GPL-2.0-or-later on the Drupal side,
  MIT for the frontend layer.
