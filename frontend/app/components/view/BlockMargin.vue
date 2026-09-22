<script setup lang="ts">
import type { BlockByline, ReviewStep } from '#shared/page-blocks'
import type { CitationSource } from '#shared/utils/comark-tree'
import { clearBoards, markActiveBlock } from '~/utils/block-board'
import { bylineTriggerLabel, bylineView, type BylineView } from '~/utils/block-byline'

/** Renders nothing. The null render emits the same comment placeholder on
 * server and client, so .page-body hydrates with matching child counts. */
defineOptions({ render: () => null })

/**
 * The per-block margin on the read page: the byline that opens a block's card
 * (OKB-82).
 *
 * The rendered page body is one Vue tree, mounted by `<MarkdownDocument>`
 * from the comark tree. There is no seam inside it to hang a Vue component off
 * a particular paragraph — but every id-bearing block already carries the
 * `id="b-…"` comark round-trips (shared/page-blocks.ts), which is the key
 * the provenance sidecar uses. So the bylines are attached the same
 * way the table of contents finds its headings: scan the rendered column, match
 * ids against the sidecar, and place one margin per entry found there.
 *
 * Which blocks get one: the CE-enrich ships an entry only for
 * a block whose sidecar attributes somebody or owes a review
 * (`blockProvenanceFrom`, server/utils/drupal-ce-enrich.ts), so an entry that
 * arrives is one worth a byline, and silence is the honest rendering of "we do
 * not know". A block that cites a source has something to say about itself the
 * same way, so it gets one whether or not the sidecar knows it. The
 * granularity stops at the document's direct children
 * (shared/page-blocks.ts), so nothing nested inside a block — a list item, a
 * table cell — has either a record or an address of its own.
 *
 * ## Why the byline is built as DOM, not as a child component
 *
 * They belong next to markup this component does not own and the server did
 * render. Mounting Vue subtrees there (a `<Teleport>` per block, the obvious
 * shape) throws during the read page's mount pass, and the page's
 * `onErrorCaptured` swallows read-mode errors — so the visible symptom is the
 * whole route silently failing to hydrate, table of contents and Edit button
 * included, with nothing in the console. Building plain elements keeps Vue's
 * tree and the body's DOM disjoint, which is the only relationship between
 * them that holds.
 *
 * This component therefore renders nothing itself: it places one control per
 * block and reports which block the reader asked about.
 *
 * ## The byline is its icon
 *
 * What a block has to say about itself is more than a margin line holds, so the
 * read page offers the ℹ that opens the block's card and nothing else. The
 * card (ViewBlockCard) is an ordinary Vue component mounted outside this body:
 * only the trigger has to live next to the block, and keeping the panel out of
 * the page's DOM is what leaves the popover's focus handling, dismissal and
 * positioning to the component library. This component owns the button and
 * reports which block was asked about; the page owns what opens.
 *
 * With no text beside it, the button's accessible name is all a screen reader
 * has, so it carries one of its own and names the block by its contributors.
 *
 * ## The ℹ is asked for
 *
 * Nearly every block in a reviewed space has a record, so an ℹ standing on each
 * of them reads as clutter rather than as an offer. It rests transparent and
 * arrives when a reader asks — hover, keyboard focus or its own open card, all
 * in CSS (`.okb-block-byline`, main.css). Touch has none of those, so the ask
 * is made here: a tap inside a block puts `.okb-block-asked` on it and on no
 * other, and a second tap opens the card. Opacity is the only thing hidden, so
 * the button keeps its tab stop and its name whatever the pointer does.
 *
 * ## Layout
 *
 * Each margin sits in a zero-height anchor after its block and is drawn
 * absolutely inside the gap the prose already leaves (`.okb-block-margin`,
 * main.css). Zero layout height is not cosmetic: the read page swaps the
 * editor in over the read column and promises that no block moves
 * (`tests/playwright/tests/edit-inplace.spec.ts` asserts it), and a margin that
 * took flow height in read mode but not in edit mode would move every block
 * below it.
 *
 * ## Which block the card is about
 *
 * A control in the margin names no block, so the open card's block wears the
 * board the editor draws around the one holding the caret — same class, same
 * rule (`markActiveBlock`, utils/block-board.ts). An outline takes no layout
 * size, so drawing it moves nothing.
 */
const props = defineProps<{
  provenance?: Record<string, BlockByline>
  /** Each block's own citations, for the blocks whose card lists sources. */
  citations?: Record<string, CitationSource[]>
  containerSelector?: string
  /** The block whose card is open, so its trigger can say so. */
  openBlockId?: string | null
  /** The review steps this space enforces, as `bylineView` reads the block. */
  steps?: readonly ReviewStep[]
  /** The reader's account, so their own agent is named as theirs. */
  viewerUid?: number | null
}>()

const emit = defineEmits<{
  /** The reader asked about a block: its id, and the button to anchor to. */
  open: [blockId: string, trigger: HTMLElement]
}>()

/** Anchors this component created, so it removes exactly its own DOM. */
let ownedAnchors: HTMLElement[] = []
/** Each block's card trigger, so `openBlockId` can be reflected onto it. */
let triggers = new Map<string, HTMLElement>()
/** Every block a margin was placed under, so one of them can wear the board. */
let boarded = new Map<string, HTMLElement>()

/** The block a touch reader asked about: main.css reveals its ℹ. */
const ASKED_CLASS = 'okb-block-asked'

/** One block at a time carries the ask, so one ℹ at a time is on screen. */
function askAbout(block: Element | null): void {
  for (const candidate of boarded.values()) candidate.classList.toggle(ASKED_CLASS, candidate === block)
}

function detach(): void {
  for (const anchor of ownedAnchors) anchor.remove()
  askAbout(null)
  clearBoards(boarded.values())
  ownedAnchors = []
  triggers = new Map()
  boarded = new Map()
}

/**
 * The ℹ button for one block — the card's trigger.
 *
 * A 24px target: it stands alone in the margin rather than inside a line of
 * text, so the inline exception in WCAG 2.2's target-size rule does not cover
 * it. It fits because the prose gap it is centred in is a line tall.
 */
function buildTrigger(id: string, view: BylineView, sources: number): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'okb-block-byline'
  button.dataset.blockCard = id
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-expanded', String(props.openBlockId === id))
  button.setAttribute('aria-label', triggerLabel(view, sources))
  // The brand marks agent-authored content, and only that, in the agent
  // colour — the block's own record is what says whether this is one.
  if (view.agentAuthored) button.classList.add('okb-block-byline--agent')
  button.textContent = 'ⓘ'
  button.addEventListener('click', () => emit('open', id, button))
  return button
}

/** The trigger's accessible name, with the sources the card lists named too. */
function triggerLabel(view: BylineView, sources: number): string {
  const label = bylineTriggerLabel(view)
  return sources > 0 ? `${label} — cites ${sources} source${sources === 1 ? '' : 's'}` : label
}

/** What a block with citations but no sidecar record says about itself. */
const NO_BYLINE: BylineView = { contributors: [], steps: [], agentAuthored: false }

/**
 * Reflect which card is open, without rebuilding anything.
 *
 * Two signals, so the board is not the only one: the button the reader pressed
 * says it is expanded, and its own block wears the board.
 */
function syncOpenBlock(): void {
  for (const [id, button] of triggers) {
    button.setAttribute('aria-expanded', String(props.openBlockId === id))
  }
  markActiveBlock(boarded, props.openBlockId ?? null)
}

function attach(): void {
  detach()
  const root = document.querySelector(props.containerSelector ?? '.page-body')
  if (!root) return

  const provenance = props.provenance ?? {}
  const citations = props.citations ?? {}
  const ids = new Set([...Object.keys(provenance), ...Object.keys(citations)])
  if (ids.size === 0) return

  for (const id of ids) {
    const byline = provenance[id]
    // The id is minted (`b-` + hex), so it is a valid selector — but the
    // sidecar is stored data, and a malformed key must not throw here.
    const block = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
    // During a read→edit swap both bodies are in the column for a tick, and the
    // editor's copy carries the same ids. Its blocks are ProseMirror's.
    if (!block || block.closest('.ProseMirror')) continue
    const anchor = document.createElement('div')
    anchor.className = 'okb-block-margin'
    anchor.dataset.blockMargin = id
    const tools = document.createElement('div')
    tools.className = 'okb-block-margin-tools'
    const view = byline ? bylineView(byline, props.steps, props.viewerUid ?? null) : NO_BYLINE
    const trigger = buildTrigger(id, view, citations[id]?.length ?? 0)
    triggers.set(id, trigger)
    tools.append(trigger)

    // Only blocks with a card can be boarded: the board marks the block whose
    // card is open (utils/block-board.ts).
    boarded.set(id, block)
    anchor.append(tools)
    block.insertAdjacentElement('afterend', anchor)
    ownedAnchors.push(anchor)
  }
  markActiveBlock(boarded, props.openBlockId ?? null)

  // A rebuild discards the button an open card is anchored to, which would
  // leave the panel pointing at a node no longer in the document. Report the
  // replacement instead of closing: the body re-renders on every save, and a
  // card that vanished whenever someone else typed would be unusable.
  const open = props.openBlockId ? triggers.get(props.openBlockId) : undefined
  if (open) emit('open', props.openBlockId!, open)
}

/**
 * Re-attach when the rendered body changes underneath us.
 *
 * The page body is Vue's DOM, not ours: `<MarkdownDocument>` re-renders it
 * whenever the page payload is refreshed (every save). Anchors inserted before
 * such a render are discarded with the nodes they sat next to, so a fixed
 * number of passes at mount is a race a body with component fences can lose.
 *
 * Our own insertions mutate the same subtree, so they are fenced off with
 * `mutating` — without it the observer would re-trigger itself forever.
 */
let observer: MutationObserver | null = null
let mutating = false
let scheduled = false

/**
 * The container, kept so the click listener is removed from what it was added
 * to — the body inside it is replaced on every render, the container is not.
 */
let listening: Element | null = null

/**
 * A tap is how a reader with no pointer asks about a block. Taps in the margin
 * are the control's own, so they leave the ask where it is; anywhere else names
 * the block it landed in, and a tap outside every block clears it.
 */
function onContainerClick(event: Event): void {
  const target = event.target
  if (!(target instanceof Element) || target.closest('.okb-block-margin')) return
  askAbout(target.closest('[id^="b-"]'))
}

function reattach(): void {
  mutating = true
  try {
    attach()
  }
  finally {
    // Release only once the observer has drained the records our own
    // insertions produced — they are delivered as a microtask.
    queueMicrotask(() => { mutating = false })
  }
}

function scheduleReattach(): void {
  if (scheduled) return
  scheduled = true
  nextTick(() => {
    scheduled = false
    reattach()
  })
}

onMounted(() => {
  reattach()
  const root = document.querySelector(props.containerSelector ?? '.page-body')
  if (!root) return
  listening = root
  root.addEventListener('click', onContainerClick)
  observer = new MutationObserver(() => {
    if (!mutating) scheduleReattach()
  })
  observer.observe(root, { childList: true, subtree: true })
})

// The read view re-fetches its payload after an edit, so the provenance can
// change under an already-mounted component — re-attach against the new body.
watch([() => props.provenance, () => props.citations, () => props.steps, () => props.viewerUid], scheduleReattach)

// Opening and closing a card changes only what the buttons announce and which
// block wears the board, so it is reflected onto the existing DOM rather than
// rebuilding it — a rebuild would destroy the very button the panel is
// anchored to.
watch(() => props.openBlockId, syncOpenBlock)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  listening?.removeEventListener('click', onContainerClick)
  listening = null
  detach()
})
</script>
