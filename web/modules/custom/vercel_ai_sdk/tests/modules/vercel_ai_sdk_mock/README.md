# Vercel AI SDK Chat mock

The `mock` AI provider: a chat provider that needs no key, for development and
CI. A site installs it and points its chat provider default — or the assistant
itself — at `mock`, and answers without an API key. Installing a module under
`tests/modules` needs `extension_discovery_scan_tests` in the site's settings.

It replaces the **model call and nothing else**. A turn served by `mock` still
runs the assistant's own system prompt, its tool rounds and whatever grounding
the site has put in front of the model — which is what lets an end-to-end run
assert on the real pipeline rather than on a stand-in for it.

The bridge names this module in one place: `mock` is listed in
`UiMessage::PROVIDER_KEYS`, so a scripted answer in the caller context is not
appended to the system prompt the way the rest of that context is. Without it a
page that scripts the mock would paste its script into a real model's prompt the
moment the provider is pointed at a real one.

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
is the chat provider default's business — `/admin/config/ai/settings`, or the
assistant where it names one of its own. This module only decides what `mock`
says.

## Scripting an answer

A scripted call answers with whatever the caller put under `mock` in the
request's caller context — the context the bridge already forwards from
`POST /vercel-ai/chat`:

```json
{
  "agentId": "my_assistant",
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

## Scripting a tool round

`tools` are the calls the model asks for before it answers:

```json
{
  "mock": {
    "text": "You may write in Ops.",
    "tools": [
      {"id": "call-1", "name": "tool__openkb_list_spaces", "arguments": {"access": "write"}}
    ]
  }
}
```

`name` is the site's own function name — `tool__<tool id>` — and the bridge
runs it for real, as the chatting account, so what comes back is the tool's own
answer rather than a stand-in for it. A name the site does not have is how a
script asks for a call that fails. `id` keys the call's parts, and is derived
from the name when it is left out.

The calls are asked for once: the round after them already carries their
results, which is what tells the two rounds apart, so how often the tools are
asked for is the bridge's loop and not a counter in here. The second round is
answered with `text` and its `metadata`, streamed as any other answer.

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
A consumer proving its own streaming needs the pacing: every layer between the
provider and the browser has to forward each frame unbuffered for it to show.
