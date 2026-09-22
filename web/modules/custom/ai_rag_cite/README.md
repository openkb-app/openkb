# AI RAG citations

Grounds a drupal/ai assistant in retrieved sources: it retrieves before the
model runs, hands it a numbered source list to cite, says where an answer
without sources came from, and publishes which sources the answer actually
used.

Generic — it knows no site's content model, no access model and no chat client.

---

## For site builders

### What it does to a turn

1. **Before the model runs** the question is retrieved for, and what comes back
   is cut three times: the score gate, `max_per_entity` passages of one page,
   and `max_sources` sources overall.
2. **A result is a passage.** Each surviving passage is a numbered source of its
   own, cited at its own address, in the order the passages scored.
3. **What survives** is appended to the assistant's own system prompt as a
   numbered `Sources:` list under the citation contract, each passage fenced in
   `<source n="…">`.
4. **What happens when nothing survives** is the assistant's mode, below.
5. **After the answer** only the sources it marked with their `[n]` are
   published; one it never cited is dropped.

Retrieval runs as the account asking, so whatever access the retriever's source
enforces is the access the answer is held to.

### Settings

Per assistant, as third-party settings, edited under **Grounding** on the
assistant form:

| Setting | What |
|---|---|
| `retriever` + `retriever_settings` | Where passages come from. |
| `mode` | `grounded` — answers always come, and ones without sources are marked as such. `strict` — nothing supporting an answer is said, and the model is not asked. |
| `score_gate` | The score a passage has to reach to be offered to the model, on the scale the index returns. Each backend and index scores on its own scale, so it is measured against the one in use, not carried over. |
| `min_sources` | Fewer than this clearing the gate leaves the turn standing on nothing, which is what `mode` decides. A set gated out this way is reported as `retrieved: 0`: the count is what the model was offered, not what the search found. |
| `max_sources`, `max_per_entity` | How many sources the model is offered, and how many passages of one page may be among them. |
| `citation_contract`, `extra_guidance` | Appended to the assistant's own system prompt. |
| `no_answer_message` | What is answered in `strict` mode, and whenever the retriever cannot be reached. |
| `ground_explorer_calls` | Whether the API Explorer's own chat calls count as this assistant's. Off by default; the first assistant that has it on claims them. Offered where `ai_api_explorer` is installed. |

**The two modes**, in the words the form uses:

- **Grounded** — answers always come; ones without sources are badged "From AI
  knowledge". With nothing retrieved the model is told so — naming the scope it
  searched — and gets nothing to cite.
- **Strict** — when nothing in the readable pages supports an answer, the
  assistant says so and does not ask the model.

A retriever that cannot be reached is a state of its own in both modes: an
outage is not an empty knowledge base.

### Debugging

**Grounding is scoped to an assistant**, by the tag drupal/ai's assistant runner
marks its calls with. A chat call from the AI API Explorer
(`/admin/config/ai/explorers`) carries `chat_generation` and `ai_api_explorer`
instead, so it is not grounded on its own.

**To ground the Explorer**, switch on *Also ground API Explorer chat calls* on
the assistant. Its chat calls then run this assistant's retrieval, gate and
mode, with whatever provider and model the Explorer is set to — the way to ask
a real question against real content and see the grounded, cited answer without
a client. The Explorer renders the response only: the appended sources block is
in the prompt, and the citations are in the response metadata, neither of which
it shows. The prompt grounding appends to is the Explorer's own *System
message* field, not the assistant's system prompt.

**To read the exact system prompt** the turn ran with — the contract, the fenced
`<source n="…">` passages and the numbering — enable `ai_logging` and read the
log entry for the call. It stores prompts, so it belongs on a development site
only.

**What the answer carries back** is `citations` and `grounding` (below). A
consumer that forwards response metadata publishes both; the OpenKB chat panel
reads them as the `data-citations` and `data-grounding` UI-message parts.

**One case, without a site**: the kernel fixtures, under *For developers*.

---

## For developers

### How it hangs on drupal/ai

Two subscribers on the provider's own events, scoped to one assistant by the
tag `ai_assistant_api_assistant_message_<id>` that drupal/ai's assistant runner
marks its calls with:

- `ai.pre_generate_response` — retrieve, gate, and append the citation contract,
  the numbered `Sources:` list and the contract again to the system prompt. What
  nothing surviving the gate means is the assistant's `mode`: `strict` forces
  the no-answer output and the model is not called at all, `grounded` tells the
  model that nothing was found and lets it answer with nothing to cite.
- `ai.post_generate_response` — keep only the sources the answer cited, drop the
  `[n]` markers that name none, and put the sources on the response as metadata.
  A streamed answer is rewritten chunk by chunk (`CitedStream`) and reports its
  sources through the iterator's completion callback, once it has been read.

Any consumer that forwards response metadata to its client gets the citations;
this module writes no markup and knows no stream protocol.

### Retrievers

`Retriever` plugins live in `Plugin/Retriever`, extend `RetrieverBase` and
answer `Source` objects. The shipped `search_api_index` plugin runs the question
as a query on a Search API index; whatever processors the index carries decide
what the account may be answered, which is what makes grounding
permission-aware without this module knowing an access model. The index has to
be entity-backed: a source is titled and addressed by the entity behind the hit,
never by what the index made of those values.

A retriever that cannot reach what it retrieves from throws
`RetrieverException`, which is a different answer from retrieving nothing.

**The caller context** of a turn reaches `retrieve()` as its second argument:
whatever the chat client sent under the request-metadata key `contexts` — the
open page, a scope the reader picked. It travels verbatim; this module reads no
key of it, so what a key means is the retriever's own contract. A retrieval
whose context differs from the one before it is run again, so a turn is never
grounded on another turn's scope. `search_api_index` narrows by nothing but the
question and ignores it.

Because the keys are the retriever's, so is the sentence about them:
`scopeDescription()` answers what the turn searched as a phrase —
`the pages of the space “Team Wiki”`, or `RetrieverInterface::WHOLE_BASE`
where nothing narrowed it — and a turn that found nothing is told to name it,
so a reader learns which scope came back empty. `RetrieverBase` answers the
whole base, which is what a retriever that narrows by nothing searched.

### Response metadata

| Key | Value |
|---|---|
| `citations` | The cited sources, `{n, title, path, meta, score}` each, in first-citation order and keeping the numbers the answer used. |
| `grounding` | `{mode, state, retrieved}` — state one of `grounded`, `ungrounded` (only in `grounded` mode), `insufficient_evidence` (only in `strict` mode), `dependency_unavailable`; `retrieved` is how many sources the answer was offered. |

### Fixtures

`tests/modules/ai_rag_cite_test` carries what a kernel test needs to drive a
turn without a provider or an index: `FakeRetriever` answers scripted `Source`
objects, and `ScriptedProvider` records the system prompt it was handed and
answers a scripted reply. A gate, a mode or a citation pass is one case in
`tests/src/Kernel/GroundingTest.php`.
