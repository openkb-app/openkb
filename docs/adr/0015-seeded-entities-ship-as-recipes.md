# ADR 0015: Seeded entities and per-environment setup ship as recipes

Status: accepted (fago, 15.09.2026); built by
[OKB-273](https://drunomics.youtrack.cloud/issue/OKB-273)

## Context

- Recipes build the site: install applies them, `phapp update`
  re-applies them, and a recipe skips what is already there. A deploy
  script or a drush command that also creates something is a second
  build mechanism, with its own idempotency and its own place in
  `phapp.yml` and `scripts/site-install.sh`.
- Some of what a site needs is content, not config: an OAuth consumer,
  seeded accounts, demo pages. A recipe carries content as
  `content/`.
- Some of it differs by environment: demo content and a mock AI
  provider on development and CI, AI logging and an in-network relay
  endpoint on CI, none of it in production.
- A recipe cannot carry a secret. The collab server's client secret
  comes from the environment (ADR 0001).
- A consumer entity requires a grant type, and the content importer
  validates what it imports.
- `openkb_agent` decides whether a request is an agent's. A personal
  consumer is a person's own client: swept when nobody owns it, gated
  when its owner is an administrator.

## Decision

1. **Recipes build the site, and only recipes.** `scripts/site-install.sh`
   applies `openkb_recipe_install`, the feature recipes and one
   environment recipe; `phapp update` re-applies the same list. Neither
   holds a conditional beyond picking the environment recipe.
2. **An entity every environment needs, with no per-environment value,
   is recipe content** in the recipe that owns the feature: the chat's
   OAuth client in `openkb_recipe_chat`, the seeded editors in
   `openkb_recipe_demo_pages`. No drush provisioning command, no
   deploy script.
3. **Per-environment setup is one recipe per kind of environment.**
   `openkb_recipe_dev` carries the demo content, the Lupus docs and the
   chat mock, and applies on every non-production environment.
   `openkb_recipe_ci` applies `openkb_recipe_dev`, AI logging and the
   CI-only settings such as the relay endpoint on the in-network
   origin, and applies on CI. Production applies neither.
4. **A deploy script exists only for a credential from the
   environment.** `scripts/setup-collab-oauth.sh` is the one. Nothing
   else qualifies.
5. **A system-wide OAuth consumer is a plain consumer.** Not personal,
   no service user, owner irrelevant. Whether a request is an agent's
   is read off the token's scopes: `agent_read` or `agent_write` means
   the agent ceiling, whichever consumer issued the token. The
   `personal` flag keeps its meaning for a person's own clients and
   decides nothing about agent-ness.
6. **Such a consumer names `refresh_token` as its grant type.** A grant
   type is required, and this is the inert one: it needs a refresh token
   nothing issues here, so the site's own issuance — `ChatAgentToken` for
   the chat — stays the only way to a token on the client.
   `client_credentials` is refused anyway on a non-confidential client
   with no secret.

## Consequences

- The chat client of ADR 0009 is content in `openkb_recipe_chat`; an
  existing site receives it on its next `phapp update`.
- `ActingIdentity::via()` answers from the agent scope. Every personal
  and self-registered client is capped to those scopes; the collab
  server's token has neither and is a direct request.
- Adding a seeded entity is one YAML file. Adding a CI setting is one
  config action in `openkb_recipe_ci`.
- Recipe content carries no password or secret. The seeded test editors
  get their passwords from the install script; what needs a secret is
  a script.
