# Vercel AI SDK Chat

Drupal module exposing `drupal/ai` providers as a Vercel AI SDK Chat protocol
HTTP endpoint with cookie auth.

The turn is a **`ChatProcessor` plugin** (`drupal/ai` 1.5), so it carries the
plugin type's configuration form, `access()`, thread/history and file-handling
contract, and any host that speaks that plugin type can run it. Two things the
plugin type does not provide stay custom here: the UI-message serializer, and
the round loop that lets a turn call tools before it answers.

This module is the **protocol bridge only**. Consumer modules ship the
`ai_assistant` config entities; the processor loads the one named in the
request body and streams the provider output as AI-SDK UI-message parts.

## Relationship to `ai_decoupled`

The contrib [AI Decoupled](https://www.drupal.org/project/ai_decoupled)
module covers the same niche — chat over `drupal/ai` for decoupled
front-ends — as configurable endpoints with executor plugins, roles and
rate limiting. It does not speak the AI-SDK UI-message protocol and its
write routes refuse same-origin cookie auth, which is what this app uses,
so this bridge stands until those land upstream. The convergence path
(contribute the stream format + a cookie/CSRF option, then replace this
module with `ai_decoupled` endpoint config) is
[OKB-140](https://drunomics.youtrack.cloud/issue/OKB-140).

## What ships

| Piece | Where |
|---|---|
| `POST /vercel-ai/chat` route | `vercel_ai_sdk.routing.yml` |
| `ChatController::stream` | reads the JSON body, picks the processor, frames each part as SSE |
| `vercel_ai_sdk` ChatProcessor | `VercelAiSdkProcessor` — loads the named `ai_assistant`, drives `drupal/ai`'s provider, runs the tool rounds, emits UI-message parts |
| `UiMessage` / `UiMessageStream` | the UI-message vocabulary: request messages in, parts out on a `drupal/ai` streamed output |
| `ChatToolRegistry` | the site's Tool API function calls, narrowed to the processor's configured tool set |
| `ChatUnavailableException` | thrown when no turn can be served, so the controller can answer 503 |
| `use vercel ai sdk chat` permission | `vercel_ai_sdk.permissions.yml` |
| `vercel_ai_sdk_mock` test module | `tests/modules/vercel_ai_sdk_mock` — the keyless `mock` provider, for development and CI |

## Auth

The route requires an authenticated session (`_user_is_logged_in: TRUE`)
and the `use vercel ai sdk chat` permission. Anonymous requests get
403. Callers must forward the Drupal session cookie.

## Request / response

`POST /vercel-ai/chat` with a JSON body:

```json
{
  "agentId": "<ai_assistant config entity id>",
  "messages": [{"role":"user","parts":[{"type":"text","text":"hi"}]}],
  "context": {"…": "optional caller context"}
}
```

`agentId` is required; a missing or empty value returns 400.

Streams `text/event-stream` framed AI-SDK UI-message parts:

```
start → start-step → reasoning-start/delta/end →
  text-start → text-delta* → text-end →
    finish-step → finish
```

A turn whose model calls tools repeats the step: each round is its own
`start-step … finish-step`, followed by the call's own parts, and the
`reasoning-*` parts appear on the first round only. `text-start` is emitted
only once text actually flows, so a round that produced nothing but tool calls
carries none.

## Tools

The module owns the loop, not the tools. `ChatToolRegistry` reads
`plugin.manager.ai.function_calls` and keeps the **`tool` group** — the Tool
API tools `tool_ai_connector` derives, which is this product's tool layer
(ADR 0009). The rest of what that manager serves is somebody else's: every
Drupal Action plugin arrives under `drupal_actions`, and a chat is not the
place to offer them. A site with no Tool API tool has a chat with no tools.

The processor names no tool and holds no schema. Its `tools` configuration
narrows the offer to named function call plugin ids, picked with `drupal/ai`'s
own `ai_tools_library` element; left empty it offers every tool the account may
call.

A turn gets up to three tool rounds. Each round's results are appended to the
conversation as the assistant's tool-call message plus one `tool` message per
call, which is the shape providers expect, so the next round reasons over the
data. The last round is asked without tools, so a model that will not stop
calling has to answer from what it has. A tool the site does not have, one
outside the configured set, and one that fails are all reported to the model as
a result — it can recover by not asking again.

Each call reaches the client as four parts keyed by its `toolCallId`:

| Part | Carries |
|---|---|
| `tool-input-start` | `toolName` — the call is named before it runs, so a client can show it while it does |
| `tool-input-available` | `toolName`, `input` — the arguments the model asked with |
| `tool-output-available` | `output` — the tool's structured result, or `{"text": …}` where it has none |
| `tool-output-error` | `errorText` — why the call did not work, for a call that failed |

All four carry `dynamic: true`: the site decides which tools exist, so the
client holds no schema for them and is handed the name as a field rather than
having to read it off the part type. The result parts carry
`providerMetadata.vercel_ai_sdk.durationMs`, how long the call took —
a result part's provider metadata is the one field of it the AI SDK keeps on
the message.

A Tool API tool reports a refused call as its own result — `success: false` and
a `message` written for whoever asked — so that message is the error text, and
the reader is told what the tool told the model. A tool that threw instead has
only its exception, which names internals: that one is logged and the call
reads `The tool "…" failed.`. Either way the assistant's own `error_message`
is kept for a turn that could not be served at all — a turn whose tool failed
was served.

A streaming provider hands a tool call over in fragments: the call id and the
function name arrive on one chunk, the arguments as pieces of JSON on the ones
after it. `drupal/ai`'s streamed iterator assembles them, and that assembly is
what the round loop runs — read off the iterator once the stream has ended,
the way the answer's response metadata is.

Everything answers for the current account by design: the model is only ever
offered tools the person chatting could have used themselves, so a tool call is
not a way around access.

## Failure handling

A chat turn that cannot be served never reads as one that was.

- **Assistant unresolvable.** `doExecute()` resolves the assistant eagerly — it
  is not itself a generator — logs at `error` and throws
  `ChatUnavailableException`. The controller has not committed a status yet,
  so the caller gets **503** with a JSON error body.
- **Provider call fails.** By then the SSE stream is open and the 200 is
  spent, so the failure is logged at `error` and emitted in-band as the
  AI-SDK protocol's own `{"type":"error"}` part, carrying the assistant's own
  `error_message` — the exception names internals and stays in the log.
  `@ai-sdk/vue` surfaces the part as an error state rather than as an answer,
  and the drawer renders it beside the turn with a *Try again*. That is the
  state a real install without a key lands in.
- **No permission, or a disabled assistant.** `access()` answers before any
  provider is touched, and the caller gets **403**.

A processor serving this endpoint must keep that shape: resolve eagerly and
throw, because anything raised from inside the returned stream is observed
only after the status is committed.

## Answering without a provider

Nothing here mocks anything: a turn is always the `vercel_ai_sdk` processor
driving the provider the assistant names. An environment with no API key points
its assistant at the `mock` provider instead, which the `vercel_ai_sdk_mock`
test module ships — so the assistant, the tool rounds, `ai_rag_cite`'s grounding
and the citation pass all run, and only the model call is replaced. See
`tests/modules/vercel_ai_sdk_mock/README.md`.

The caller context travels onto every round's `ChatInput` as request metadata,
which is what lets a provider answer differently for one request without any
of them naming a key of it.

## Admin entry points

| URL | What |
|---|---|
| `/admin/config/ai` | Default provider per operation, request timeout, guardrails |
| `/admin/config/ai/providers` | Per-provider config + key binding |
| `/admin/config/ai/ai-assistant` | Assistant list |
| `/admin/config/ai/chat-mock` | What the `mock` provider answers, while `vercel_ai_sdk_mock` is installed |
