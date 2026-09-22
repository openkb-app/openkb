<script setup lang="ts">
/**
 * The Ask OpenKnowledgebase conversation as a plain column: header band,
 * message scroller, composer. The page's side pane renders it from `lg`, the
 * slideover below that.
 */
import type {
  UIMessage,
  UIMessagePart,
  ToolUIPart,
  DynamicToolUIPart,
} from 'ai'
import { backendUrl } from '#shared/utils/user'
import { SCOPE_ALL, scopeLabel } from '#shared/utils/chat-scope'

const emit = defineEmits<{ close: [] }>()

const { draft, closeChat, takeChatFocus, wide } = useSidePane()

// `unsent` and `scrollTop` outlive this component, because the pane it renders
// in remounts with the page: what is half-typed and where the reader had read
// to are as much the conversation as its messages are.
const { chat, messages, status, needsAuth, error, clear, unsent: prompt, scrollTop, scope } = useChatPanelSession()

// A refused log-in has its own alert with somewhere to go, so it is not also
// worded as a failed turn.
const turnError = computed(() => (needsAuth.value ? null : error.value))

/** A turn is on its way: asked for, or arriving. */
const busy = computed(() => status.value === 'streaming' || status.value === 'submitted')

const suggestions = [
  'Summarise the architecture overview',
  'What changed in authoring this week?',
  'Find duplicate pages',
]

// The page the reader has open travels with the turn, so the assistant can act
// on "this page" without being told the path. Only the catch-all page route is
// such a page; search and space listings have nothing the tools can address.
const route = useRoute()
const pagePath = computed(() => (route.name === 'slug' ? route.path : null))

// The space that page lives in travels with it: under the whole-knowledge-base
// scope it biases retrieval towards what the reader is looking at.
const { slug: pageSpace } = useActiveSpace()

const { spaces } = useSpaces()

// A scope naming a space this reader cannot see is a narrowing that answers
// nothing, so it widens back out — once a loaded list says it is one.
watch([scope, spaces], ([picked, seen]) => {
  if (picked === SCOPE_ALL || !seen.length) return
  if (!seen.some(space => space.slug === picked)) scope.value = SCOPE_ALL
}, { immediate: true })

function send(text: string) {
  const context = {
    scope: scope.value,
    ...(pagePath.value ? { path: pagePath.value } : {}),
    ...(pageSpace.value ? { space: pageSpace.value } : {}),
  }
  void chat.sendMessage({ text }, { body: { context } })
}

function submit() {
  const text = prompt.value.trim()
  if (!text) return
  prompt.value = ''
  send(text)
}

function ask(text: string) {
  if (busy.value) return
  send(text)
}

function isToolPart(p: UIMessagePart): p is ToolUIPart | DynamicToolUIPart {
  return typeof p.type === 'string' && p.type.startsWith('tool-')
}

// What each answer was asked, so the reader is told what was searched.
const questions = computed(() => {
  const asked = new Map<string, string>()
  let last = ''
  for (const m of messages.value) {
    if (m.role === 'user') last = textFor(m)
    else asked.set(m.id, last)
  }
  return asked
})

function questionFor(m: UIMessage): string {
  return questions.value.get(m.id) ?? ''
}

// Taking the caret here also spends a pending open, so a chat that is already
// up does not take it again on the next page.
function focusComposer() {
  takeChatFocus()
  void nextTick(() => composer.value?.querySelector('textarea')?.focus())
}

// Put the question back in the composer to edit, and focus it: the reader
// has to act next, so that is where the focus belongs.
function rephrase(question: string) {
  prompt.value = question
  focusComposer()
}

// This panel remounts with every page, so the composer takes the caret only on
// the mount that follows an open — never on a navigation with the chat up.
onMounted(() => { if (takeChatFocus()) focusComposer() })

// A question handed over by another surface lands in the composer, unsent, so
// the reader edits it here rather than re-typing it.
watch(draft, (question) => {
  if (!question) return
  draft.value = ''
  rephrase(question)
}, { immediate: true })

/**
 * A citation link is being followed.
 *
 * The link navigates on its own; this only gets the chat out of the way on a
 * phone, where it covers the page it leads to. `defaultPrevented` is the link
 * having claimed the event, so a modified click leaves the chat up.
 */
function onCitationNavigate(ev: MouseEvent) {
  if (ev.defaultPrevented && !wide.value) closeChat()
}

// The scope is the conversation's, not the browser's: it is picked for a
// thread and goes when the thread does.
function clearChat() {
  clear()
  scope.value = SCOPE_ALL
}

/** X ends the conversation. Also clears the unsent text and the scroll position. */
function endChat() {
  clearChat()
  prompt.value = ''
  scrollTop.value = 0
  emit('close')
}

function onAnswerClick(ev: MouseEvent) {
  if ((ev.target as HTMLElement | null)?.closest('a.cite-chip')) onCitationNavigate(ev)
}

function loginHref(): string {
  return backendUrl(useRuntimeConfig().public.drupalBaseUrl as string | undefined, '/user/login')
}

function toolText(p: ToolUIPart | DynamicToolUIPart): string {
  const name = (p as { toolName?: string }).toolName ?? 'tool'
  return `Called ${name}`
}

// How the finished answer stands, in one line to be heard.
const announcement = computed(() => {
  if (busy.value) return ''
  if (turnError.value) return turnError.value
  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'assistant') return ''
  return announce(groundingFor(last), citationsFor(last).length)
})

const composer = useTemplateRef<HTMLElement>('composer')
const list = useTemplateRef<{ $el?: HTMLElement }>('list')
const scroller = useTemplateRef<HTMLElement>('scroller')

// A reader at the end of the conversation stays there while the list settles:
// for a few hundred ms after an answer ends the list still grows and the
// scroller still shrinks under the returning suggestions, and both move the end.
let atEnd = true
let ownTop = 0

/** The gap above the question at the top, so it does not touch the band. */
const PIN_GAP = 8

// The question the pane keeps at its top, so the answer is read from its first
// line. It is kept there while the answer arrives, and afterwards only when the
// answer is taller than the pane; a shorter answer settles at the end of its
// content instead.
let pinned: HTMLElement | null = null
watch(() => list.value?.$el, (el, _old, onCleanup) => {
  const box = scroller.value
  if (!el || !box) return
  // The list pads the last turn so its question can reach the top of the pane.
  // The padding is a min-height on the turn element and not on its child, so
  // the child is what ends the list.
  const content = () => {
    const turns = box.querySelectorAll<HTMLElement>('[data-role]')
    return turns[turns.length - 1]?.lastElementChild ?? null
  }
  /** The end of what there is to read, as a scroll position. */
  const readable = () => {
    const last = content()
    if (!last) return box.scrollHeight
    return box.scrollTop + last.getBoundingClientRect().bottom - box.getBoundingClientRect().top
  }
  /** Whether the reader is at that end, which the pane's scroll height is past. */
  const nearEnd = () => readable() - box.scrollTop - box.clientHeight < 40
  // Back to where the reader was before this mount, which is the end unless
  // they had scrolled up out of it.
  if (scrollTop.value) {
    box.scrollTop = scrollTop.value
    ownTop = box.scrollTop
    atEnd = nearEnd()
  }
  // The padding also takes up what the turn gives back when the reasoning
  // folds itself away: the end moves while the list and the pane keep their
  // size, so the turn's content is measured for itself, turn by turn.
  let watched: Element | null = null
  const watchEnd = () => {
    const last = content()
    if (last === watched) return
    if (watched) settling.unobserve(watched)
    if (last) settling.observe(last)
    watched = last
  }
  const follow = () => {
    watchEnd()
    if (pinned && !box.contains(pinned)) pinned = null
    const answer = [...box.querySelectorAll<HTMLElement>('.chat__answer')].pop()
    const tall = !!answer && answer.getBoundingClientRect().height > box.clientHeight - PIN_GAP
    if (pinned && (tall || busy.value)) {
      const offset = pinned.getBoundingClientRect().top - box.getBoundingClientRect().top
      box.scrollTop = box.scrollTop + offset - PIN_GAP
    }
    else if (atEnd) {
      // The list shrinks after an answer ends, above the last turn as well, so
      // the end has to be followed upwards too. The browser clamps a negative
      // target to 0, which is where a conversation shorter than the pane sits.
      box.scrollTop = readable() - box.clientHeight
    }
    else return
    ownTop = box.scrollTop
    scrollTop.value = ownTop
  }
  // A scroll event is delivered a frame late, by when the list may have grown
  // past it. Only a scroll the reader made says they left the end.
  const onScroll = () => {
    if (box.scrollTop === ownTop) return
    pinned = null
    atEnd = nearEnd()
    scrollTop.value = box.scrollTop
  }
  const settling = new ResizeObserver(follow)
  settling.observe(el)
  settling.observe(box)
  box.addEventListener('scroll', onScroll, { passive: true })
  onCleanup(() => {
    settling.disconnect()
    box.removeEventListener('scroll', onScroll)
  })
}, { flush: 'post' })

// Every question asked from here is the one the pane keeps at its top while
// its answer arrives.
watch(() => messages.value.filter(m => m.role === 'user').length, async (asked, before) => {
  if (!asked || asked === before) return
  await nextTick()
  const box = scroller.value
  const asks = box?.querySelectorAll<HTMLElement>('[data-role="user"]')
  pinned = asks?.length ? asks[asks.length - 1]! : null
})

const hasMessages = computed(() => messages.value.length > 0)

const lastMessage = computed(() => messages.value[messages.value.length - 1])
const lastMessageId = computed(() => lastMessage.value?.id)

// A turn that failed before the assistant's message existed has no bubble to
// hang its state on, so the panel carries it.
const strayError = computed(() =>
  turnError.value && lastMessage.value?.role !== 'assistant' ? turnError.value : null,
)

/** The question a stray error's retry re-asks: the last thing typed. */
const strayQuestion = computed(() => {
  const last = lastMessage.value
  return last ? textFor(last) : ''
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-(--okb-ground)">
    <ChromeSidePaneBand class="bg-(--ui-bg)">
      <ChatHeader v-model:scope="scope" @clear="clearChat" />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Close the chat"
        class="shrink-0"
        @click="endChat"
      />
      <!-- The frame's own control sits outermost: the chat closes back to what
           the page put in the pane, the pane closes the lot. -->
      <slot name="controls" />
    </ChromeSidePaneBand>

    <div ref="scroller" data-test="chat-scroller" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <UAlert
        v-if="needsAuth"
        color="warning"
        variant="soft"
        icon="i-lucide-lock"
        title="Log in to chat"
        class="m-3"
      >
        <template #description>
          <a :href="loginHref()" class="font-medium underline">
            Open the Drupal login page
          </a>
          and come back to ask OpenKnowledgebase.
        </template>
      </UAlert>

      <!-- Always in the DOM, so what lands in it is announced. -->
      <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

      <!-- Empty state: with no seeded thread the panel shows the assistant's
           own mark and prompt suggestions, so it does not read as broken. -->
      <div
        v-if="!hasMessages && !needsAuth"
        data-test="chat-empty"
        class="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
      >
        <span
          class="flex h-10 w-10 items-center justify-center rounded-lg bg-(--okb-agent-text) text-inverted shadow"
        >
          <UIcon name="i-lucide-sparkles" class="size-5" />
        </span>
        <div class="text-sm font-semibold text-(--ui-text-highlighted)">
          Ask anything across your spaces
        </div>
        <div class="max-w-xs text-[12.5px] leading-relaxed text-(--ui-text-muted)">
          Answers cite the pages they came from — and stay scoped to what you
          can see.
        </div>
      </div>

      <UChatMessages
        v-else
        ref="list"
        :messages="messages"
        :status="status"
        :user="{ side: 'right', variant: 'soft' }"
        :assistant="{
          side: 'left',
          variant: 'naked',
          icon: 'i-lucide-sparkles',
          ui: {
            leading: 'rounded-md text-white flex items-center justify-center size-7',
            leadingIcon: 'size-4',
          },
        }"
        class="p-4"
      >
        <template #content="{ message }">
          <!-- Reasoning step (collapsible "Thinking…") -->
          <template v-for="(part, idx) in message.parts" :key="`r-${idx}`">
            <UChatReasoning
              v-if="isReasoning(part)"
              :text="part.text"
              :streaming="status === 'streaming' && idx === message.parts.length - 1"
            />
            <UChatTool
              v-else-if="isToolPart(part)"
              :text="toolText(part)"
              :icon="'i-lucide-search'"
              :loading="part.state === 'input-streaming' || part.state === 'input-available'"
            >
              <pre class="text-xs">{{ JSON.stringify(part.output ?? part.input, null, 2) }}</pre>
            </UChatTool>
          </template>

          <!-- Assistant prose: comark components + clickable [n] chips. -->
          <div
            v-if="message.role === 'assistant'"
            class="chat__answer okb-prose"
            @click="onAnswerClick"
          >
            <ComarkAnswer :text="textFor(message)" :citation-chips="citationsFor(message)" />
          </div>

          <!-- User message: plain text -->
          <div
            v-else
            class="whitespace-pre-wrap"
          >{{ textFor(message) }}</div>

          <!-- How the answer stands: uncited, or nothing to answer from -->
          <ChatAnswerState
            v-if="message.role === 'assistant'"
            :grounding="groundingFor(message)"
            :cited="citationsFor(message).length"
            :query="questionFor(message)"
            :error="message.id === lastMessageId ? turnError : null"
            @rephrase="rephrase(questionFor(message))"
            @retry="ask(questionFor(message))"
          />

          <!-- Cited sources under the assistant message -->
          <div
            v-if="message.role === 'assistant' && linkedCitationsFor(message).length"
            class="mt-3 rounded-md border border-(--ui-border-muted) bg-(--ui-bg-muted) p-2"
          >
            <div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-(--ui-text-muted)">
              <UIcon name="i-lucide-link-2" class="size-3" />
              Sources
              <span class="ml-auto text-(--ui-text-dimmed)">{{ linkedCitationsFor(message).length }}</span>
            </div>
            <NuxtLink
              v-for="c in linkedCitationsFor(message)"
              :key="c.n"
              :to="c.path"
              data-test="source-row"
              :data-cite-n="c.n"
              class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-(--ui-bg-elevated)"
              @click="onCitationNavigate"
            >
              <UIcon name="i-lucide-file-text" class="size-3.5 text-(--color-primary-600)" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs font-medium">
                  [{{ c.n }}] {{ c.title }}
                </div>
                <div data-test="source-meta" class="truncate text-[11px] text-(--ui-text-muted)">
                  {{ c.meta }}
                </div>
              </div>
              <span class="font-mono text-[10px] text-(--ui-text-dimmed)">{{ c.score.toFixed(2) }}</span>
            </NuxtLink>
          </div>
        </template>
      </UChatMessages>

      <div v-if="strayError" class="px-4 pb-4">
        <ChatAnswerState
          :grounding="null"
          :cited="0"
          :error="strayError"
          @retry="ask(strayQuestion)"
        />
      </div>
    </div>

    <div class="flex shrink-0 flex-col border-t border-default bg-(--ui-bg)">
      <UChatPalette
        v-if="!hasMessages || status === 'ready'"
        class="border-b border-(--ui-border-muted) bg-(--ui-bg) px-3 py-2"
      >
        <div class="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-(--ui-text-dimmed)">
          <UIcon name="i-lucide-wand-sparkles" class="size-3" />
          Suggested
        </div>
        <div class="flex flex-wrap gap-1.5">
          <UButton
            v-for="s in suggestions"
            :key="s"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="'i-lucide-sparkles'"
            @click="ask(s)"
          >
            {{ s }}
          </UButton>
        </div>
      </UChatPalette>

      <div ref="composer" class="px-3 pb-3 pt-2">
        <ChatComposer
          v-model="prompt"
          :status="status"
          :scope="scopeLabel(scope, spaces)"
          :chat="chat"
          @submit="submit"
        />
      </div>
    </div>
  </div>
</template>
