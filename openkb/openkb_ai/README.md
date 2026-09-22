# openKB AI

openKB-specific consumer of `vercel_ai_sdk`. Provides the AI assistant config
entity that the Vercel AI SDK chat bridge loads. Its prompt is the entity's
*Instructions* — the field the assistant form edits — and it is locked to the
comark/MDC fence syntax used by the openKB Nuxt frontend.

## What ships

| Piece | Where |
|---|---|
| `ai_assistant.openkb` config entity | `config/install/ai_assistant_api.ai_assistant.openkb.yml` |

The assistant id `openkb` is the value the Nuxt proxy sends as `agentId` in
the chat request body, which `vercel_ai_sdk` then resolves to the entity here.

## Dependencies

- `vercel_ai_sdk` — the protocol bridge / HTTP endpoint.
- `ai_assistant_api` — the config entity type.
- `comark` — the markdown format the system prompt targets.

## Citations

The module ships no citations. `vercel_ai_sdk`'s stream carries whatever
`source-document` / `data-citations` parts a retriever emits, and the frontend
renders a Sources block when they arrive — until RAG retrieval against
`kb_page` lands, nothing does.

## TODO

- RAG retrieval actions against `kb_page`, emitting real citation parts.
