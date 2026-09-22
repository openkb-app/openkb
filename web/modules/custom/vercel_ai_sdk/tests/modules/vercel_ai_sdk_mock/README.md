# Vercel AI SDK Chat mock

The `mock` AI provider: a chat provider that needs no key, for development and
CI. `openkb_recipe_chat_mock` installs it and points the `openkb` assistant at
it; a production install applies neither. Installing a module under
`tests/modules` needs `extension_discovery_scan_tests`, which
`web/sites/all/base.settings.php` sets for every environment.

It replaces the **model call and nothing else**. An assistant pointed at `mock`
still runs its own system prompt, its tool rounds, `ai_rag_cite`'s retrieval,
score gate and citation pass — which is what lets an end-to-end run assert on
the grounded pipeline rather than on a stand-in for it.

The bridge names this module in one place: `mock` is listed in
`UiMessage::PROVIDER_KEYS`, so a scripted answer in the caller context is not
appended to the system prompt the way the rest of that context is. Without it a
page that scripts the mock would paste its script into a real model's prompt the
moment the assistant is pointed at OpenAI.

## Modes

`vercel_ai_sdk_mock.settings` says what an answer is made of. It is config, read
per call, so an admin changes it at **/admin/config/ai/chat-mock** or with
`drush config:set`, with no rebuild and no cache rebuild.

| `mode` | What the provider answers |
|---|---|
| `canned` | The `answer` setting, with `@prompt` for the question the assistant asked. Nothing in the request steers it. |
| `scripted` | The answer, and the data parts that ride with it, from the request's caller context — falling back to the canned text. For end-to-end runs and Itests. |

The shipped settings are the ones CI and local development want: `scripted`,
paced at 40 ms.

**There is no mode that means "use the real provider".** Which provider answers
is the assistant's business: point it at OpenAI on
`/admin/config/ai/ai-assistant/openkb` and point it back at `mock` when you are
done.

## Scripting an answer

A scripted call answers with whatever the caller put under `mock` in the
request's caller context — the context the bridge already forwards from
`POST /vercel-ai/chat`:

```json
{
  "agentId": "openkb",
  "messages": [{"role": "user", "parts": [{"type": "text", "text": "How do we release?"}]}],
  "context": {
    "mock": {
      "text": "Cut the tag [1], then deploy [2].",
      "metadata": {
        "citations": [{"n": 1, "title": "Release checklist", "path": "/release-checklist"}],
        "grounding": {"mode": "grounded", "state": "grounded"}
      },
      "delay_ms": 40
    }
  }
}
```

`text` is what the model said, and a script that names none keeps the canned
answer. `metadata` is the provider's response metadata, which the bridge
publishes as `data-<key>` parts — the same route a real grounded turn's
citations take, so no grounding vocabulary lives here or in the bridge.
`delay_ms` paces this one answer, capped at 100 ms because the value comes from
the request. A script that is not an answer fails the call rather than
vanishing: it comes from a test that means to assert on what it asked for.

A `canned` call ignores all of it.

## Streaming

The provider answers the way it was asked to. A chat turn is streamed, so it
gets a paced iterator whose frames each carry their own raw payload — which is
what `ai_logging` stores as the turn's response. A caller that asked for no
stream, such as the API Explorer or any non-chat AI operation, gets one
`ChatMessage`.

## Pacing

The answer leaves in one PHP tick otherwise, which reads on the wire exactly
like a stack that buffered a real one. `delay_ms` in the settings paces every
answer on the site; `mock.delay_ms` in the context paces one, under `scripted`.
`docs/ai-chat.md` ("Streaming requirements") holds what the rest of the stack
owes a stream.
