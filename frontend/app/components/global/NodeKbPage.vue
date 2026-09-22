<script setup lang="ts">
/**
 * The `node-kb-page` element: the page read surface, and the editable-node
 * machinery wired around it. Global and named after the element, so the CE
 * renderer resolves it for the page payload exactly as it resolves
 * `NodeRevisionHistory` for a history — the catch-all stays generic and knows
 * no content shape.
 *
 * The edit session, moderation lane and review gate are content-type agnostic
 * (the `useKb*` composables); a second editable type reuses them and declares
 * only its own read surface. This component owns the read surface — meta strip,
 * heading, author meta, body, block bylines/cards and TOC — plus the navbar and
 * edit chrome that frame it.
 */
import { MarkdownDocument } from '@comark/vue'
import { comarkComponents } from '~/comark/components'
import { liftTitleBlockId, type CitationSource, type ComarkNode } from '#shared/utils/comark-tree'
import { referenceLabels, type CeEntityReference } from '#shared/utils/kb-meta'
import { spaceReviewSteps, spaceSlug, type KbSpaceCeProp } from '#shared/utils/kb-spaces'
import { enforcedSteps, mayModerate } from '#shared/utils/moderation'
import { BLOCK_ID_PREFIX, TITLE_REVIEW_KEY, type BlockByline, type ReviewStep } from '#shared/page-blocks'
import { assigneeCandidates } from '~/editor/comment-assignee'
import { itemName, reviewMarkOf } from '~/editor/review-marks'
import type { CommentAssignee } from '#shared/block-comments'

// Flat props off the CE display — no defaults, no placeholders: a field the
// editor left empty renders as nothing at all. The body arrives as the comark
// tree the CE-enrich splice resolved (server/utils/drupal-ce-enrich.ts).
const props = defineProps<{
  title?: string
  nid?: string | number
  type?: string
  summary?: string
  changed?: string | number
  owner?: CeEntityReference
  tags?: CeEntityReference[]
  /** The page's space, rendered into the page response as an object. */
  space?: KbSpaceCeProp
  /** Derived from `field_block_meta` by the CE-enrich splice (OKB-82). */
  blockProvenance?: Record<string, BlockByline>
  /** Each block's own citations, projected off the resolved body tree. */
  blockCitations?: Record<string, CitationSource[]>
  bodyTree?: ComarkNode[]
}>()

const env = useKbCePage()
const nodeId = computed(() => Number(props.nid) || undefined)

// The raw-markdown projection of the page at this path — the address IS the
// route, so the `.md` link is the current path with a `.md` suffix (a page
// has no slug field to build it from; the path alias is the address).
const route = useRoute()
const rawHref = computed(() => `/api/kb${route.path}.md`)

const moderation = useModerationStatus(nodeId, env.canEdit)
const {
  status: moderationStatus,
  busy: moderationBusy,
  refresh: refreshModeration,
  revertToPublished,
} = moderation

/**
 * The ¶ in a block's margin is an ordinary link — the browser sets the hash.
 * Clicking it also puts the whole URL on the clipboard, so sharing a block
 * costs no trip to the address bar. Delegated, because the rendered body is
 * DOM this component does not own (ViewBlockMargin explains why).
 */
const { copy: copyText } = useCopyText()
function copyBlockLink(event: MouseEvent): void {
  const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a.okb-block-link')
  if (link) copyText(location.href.split('#')[0] + link.hash, 'Link')
}

const editSession = useKbNodeEditSession(env, {
  nid: computed(() => props.nid),
  refreshModeration,
})
const {
  mode,
  session,
  setSession,
  fmOpen,
  editorInstance,
  title,
  startEdit,
  startEditAtBlock,
  closeEditor,
  save,
  onDeleted,
} = editSession

const {
  reviewOpen,
  reviewParked,
  awaitingCount,
  unidentifiedCount,
  reviewableNow,
  reviewRows,
  commentThreads,
  assigned,
  goToReviewBlock,
  goToCommentBlock,
  publishPage,
} = useKbReviewGate(editSession, moderation)

// What the review surface is given, and what it reports back. One block, so
// the pane's frame and the phone's slideover can never drift apart.
const reviewSurface = computed(() => ({
  queue: reviewRows.value,
  steps: enforcedSteps(moderationStatus.value),
  threads: commentThreads.value,
  commentDraft: session.value?.commentDraft.value ?? null,
  threadsShownFor: session.value?.threadsShownFor.value ?? null,
  assigneeCandidates: commentAssignees.value,
  me: session.value?.me.value ?? null,
  unidentified: unidentifiedCount.value,
}))

/**
 * What the sidecar says about the title — the heading's own pills. A rename is
 * a review item like a block's text (ADR 0017), so the mark is read the same
 * way and named for the title rather than for a block.
 */
const titleReview = computed(() => reviewMarkOf(
  session.value?.blockMeta.value[TITLE_REVIEW_KEY],
  enforcedSteps(moderationStatus.value),
  session.value?.reviewer.value ?? { uid: null, isAdmin: false },
  itemName(TITLE_REVIEW_KEY),
))

const reviewEvents = {
  jump: goToReviewBlock,
  approve: (e: { item: string, step: ReviewStep }) => session.value?.approveItem(e.item, e.step),
  jumpBlock: goToCommentBlock,
  postComment: (e: { text: string, assignee: CommentAssignee | null }) =>
    session.value?.postComment(e.text, e.assignee),
  discardComment: () => { if (session.value) session.value.commentDraft.value = null },
  replyComment: (e: { blockId: string, threadId: string, text: string }) =>
    session.value?.replyToComment(e.blockId, e.threadId, e.text),
  resolveComment: (e: { blockId: string, threadId: string, resolved: boolean }) =>
    session.value?.setCommentResolved(e.blockId, e.threadId, e.resolved),
  assignComment: (e: { blockId: string, threadId: string, assignee: CommentAssignee | null }) =>
    session.value?.setCommentAssignee(e.blockId, e.threadId, e.assignee),
}

/**
 * Double-clicking a block opens the editor with the caret in it — the gesture
 * already selects a word, which makes it the one an editor edits by. A link
 * keeps its own click, and a reader who may not write this page keeps the
 * selection and nothing else.
 */
function editBlockAt(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('a')) return
  const block = target?.closest<HTMLElement>(`[id^="${BLOCK_ID_PREFIX}"]`)
  if (block) startEditAtBlock(block.id)
}

// --- Read surface derivations ----------------------------------------------
// The body opens on the heading that repeats the title, hidden below because
// the page's own <h1> spells it. That heading is the block a citation on the
// page's lead section names, so its id moves to the <h1> a reader can see.
const body = computed(() => liftTitleBlockId(props.bodyTree ?? []))
const summary = computed(() => props.summary?.trim() || undefined)

/**
 * A frontmatter field as the live Details form holds it, or undefined outside
 * edit mode and where the form carries nothing for it. The read-style meta
 * above the body reads through this, so an edit in the form shows there before
 * any save; every field falls back to the page prop.
 */
function liveField(key: string): unknown {
  if (mode.value !== 'edit') return undefined
  return session.value?.frontmatter.field(key).value ?? undefined
}

function liveLabels(key: string): string[] | undefined {
  const value = liveField(key)
  return value === undefined
    ? undefined
    : referenceLabels(value as CeEntityReference | CeEntityReference[])
}

const docType = computed(() => (liveField('type') as string | undefined) ?? props.type)
const owner = computed(() => (liveLabels('owner') ?? referenceLabels(props.owner))[0])
const tags = computed(() => liveLabels('tags') ?? referenceLabels(props.tags))

/**
 * The control of one frontmatter field in the Details form. The form puts the
 * key's own id on it (FrontmatterForm.vue); the wrapper's first control is the
 * fallback for a widget that keeps the id off its focusable element.
 */
function fieldControl(key: string): HTMLElement | null {
  return document.getElementById(`frontmatter-${key}`)
    ?? document.querySelector<HTMLElement>(`[data-field="${key}"] :is(input,select,textarea,button)`)
}

/**
 * Opens the Details form on one field and focuses it — the read-style meta is
 * where that data shows in edit mode, so a click on it asks to edit it. Opens,
 * never toggles. The form mounts on `fmOpen` and paints its fields a frame
 * later, hence the second look.
 */
async function editFrontmatterField(key: string): Promise<void> {
  fmOpen.value = true
  await nextTick()
  const control = fieldControl(key)
    ?? await new Promise<HTMLElement | null>(resolve =>
      requestAnimationFrame(() => resolve(fieldControl(key))))
  control?.focus()
}

// The page's own space, read straight off the payload — the trail's anchor.
// A page whose space the session may not view carries no space prop at all
// (Drupal drops the reference), so it gets no space crumb rather than a wrong
// one. The rest of the trail comes from the outline the sidebar renders.
const pageSpace = computed(() => {
  const space = props.space
  return space?.name ? { name: space.name, slug: spaceSlug(space.path ?? '') } : undefined
})

// Who a comment can be handed to: the session's own peers, plus this space's
// other editors. The roster is read only in the editor, where threads are
// assigned; a space the session may not read leaves the peers in the room.
const { data: spaceDetail } = useSpaceDetail(
  computed(() => (session.value ? pageSpace.value?.slug : undefined)),
)
// The reader's own agents are assignable whether or not they are here: the
// thread waits, and the agent is answered it when it next connects. Read only
// in the editor, where threads are assigned.
const myAgents = useMyAgents(computed(() => !!session.value))
const { uid: myUid, name: myName } = useCurrentUser()
const commentAssignees = computed(() => assigneeCandidates(
  session.value?.presence.value ?? [],
  [...(spaceDetail.value?.managers ?? []), ...(spaceDetail.value?.members ?? [])],
  myUid.value == null
    ? null
    : { uid: myUid.value, name: myName.value ?? '', agents: myAgents.value },
))

// --- Read-page block cards -------------------------------------------------
//
// The card panel is mounted once for the page and told which block it is about;
// the triggers live in the rendered body, which is DOM this component does not
// own (ViewBlockMargin explains why). Closing is expressed as clearing the
// block, so there is one piece of state and no way for the two to disagree.
const cardBlockId = ref<string | null>(null)
const cardTrigger = shallowRef<HTMLElement | null>(null)
const cardByline = computed(() =>
  (cardBlockId.value ? props.blockProvenance?.[cardBlockId.value] : null) ?? null)
const cardSources = computed(() =>
  (cardBlockId.value ? props.blockCitations?.[cardBlockId.value] : null) ?? null)
const cardOpen = computed({
  get: () => cardBlockId.value !== null,
  set: (isOpen: boolean) => { if (!isOpen) cardBlockId.value = null },
})

function openBlockCard(blockId: string, trigger: HTMLElement) {
  cardBlockId.value = blockId
  cardTrigger.value = trigger
}

// Entering the editor replaces the body the triggers were attached to, and the
// same sidecar is projected onto the surface as marks there instead.
watch(mode, (to) => { if (to !== 'read') cardBlockId.value = null })

/**
 * The per-block tools beside the toolbar, unwrapped because `session` is a
 * plain object behind a ref and this property is itself a computed.
 */
const trailingToolbarItems = computed(() => session.value?.toolbarTrailingItems.value ?? [])

/**
 * The steps this space enforces, as the read surfaces answer it.
 *
 * The moderation status is Drupal's own answer, but it sits behind node.update
 * — a reader never has one. The space rides the page payload with the two
 * policy flags on it, so the same rule is derivable without it; the status
 * still wins where there is one.
 */
const reviewSteps = computed<readonly ReviewStep[]>(() =>
  (env.canEdit.value && moderationStatus.value
    ? enforcedSteps(moderationStatus.value)
    : spaceReviewSteps(props.space)))

/**
 * The same steps for the block card, or null when this session was never told.
 *
 * Fails open, unlike `reviewSteps`: the card states what publishing waits for,
 * so it must not claim a step the space may not enforce.
 */
const cardEnforcedSteps = computed<readonly ReviewStep[] | null>(() => {
  if (env.canEdit.value && moderationStatus.value) return enforcedSteps(moderationStatus.value)
  return props.space?.moderation === undefined ? null : spaceReviewSteps(props.space)
})

// The page is the one page with a pane, and what belongs in it depends on
// what the reader is doing: the outline while reading, the review surface while
// editing — unless Review was closed, which hands this page's pane back to the
// outline. Below `lg` there is no pane and the outline follows the page.
const { wide } = useSidePane()
</script>

<template>
  <ChromeAppNavbar>
    <!-- The leading zone holds the trail when reading and the formatting
         toolbar when editing, at the same header height either way, so
         entering edit pushes nothing down. Below `sm` the toolbar takes the
         row below instead. -->
    <template #leading>
      <!-- One clipping strip: toolbar and block tools scroll together in the
           `min-w-0` leading zone, so no control spills over the action
           chrome. -->
      <div v-if="mode === 'edit' && editorInstance && session" class="hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex">
        <!-- Two zones: left of the rule writes at the caret, right of it acts
             on the block. Each `@min-[…]` is the measured row width that group
             needs; the extended set folds into one menu rather than going
             away — a shorter row must not cost the editor a tool. -->
        <UEditorToolbar :editor="editorInstance" :items="session.historyItems" class="shrink-0 border-0 bg-transparent" />
        <UEditorToolbar :editor="editorInstance" :items="session.toolbarItems" class="border-0 bg-transparent" />
        <UEditorToolbar :editor="editorInstance" :items="session.toolbarExtendedItems" class="hidden border-0 bg-transparent @min-[1020px]/editnav:flex" />
        <UEditorToolbar :editor="editorInstance" :items="session.toolbarOverflowItems" class="shrink-0 border-0 bg-transparent @min-[1020px]/editnav:hidden" />
        <USeparator orientation="vertical" class="h-5 shrink-0" />
        <div class="flex shrink-0 items-center gap-1" role="group" aria-label="This block">
          <span class="hidden text-xs text-muted @min-[900px]/editnav:inline">Block</span>
          <UEditorToolbar :editor="editorInstance" :items="trailingToolbarItems" class="hidden shrink-0 border-0 bg-transparent @min-[672px]/editnav:flex" />
          <EditorBlockMenuButton :session="session" class="shrink-0" />
        </div>
        <!-- The way back. Everything the block tools do lands on the block the
             caret is in, but the keys only bite once ProseMirror owns DOM
             focus again — and by Tab that is the whole action chrome away.
             One stop instead, hidden until it takes focus. -->
        <a
          href="#page-editor"
          data-testid="skip-to-editor"
          class="sr-only shrink-0 z-50 rounded-md bg-primary px-4 py-2 text-sm font-medium text-inverted focus:not-sr-only focus:fixed focus:left-4 focus:top-16"
        >
          Skip to editor
        </a>
      </div>
      <!-- Read view only — in edit mode the leading row belongs to the
           formatting toolbar. -->
      <KbBreadcrumbs
        v-if="mode !== 'edit' || !editorInstance || !session"
        :title="title"
        :page-space="pageSpace"
        class="flex-1"
      />
    </template>

    <template #actions>
      <NodeEditActions
        v-if="mode === 'edit' && session"
        v-model:review-open="reviewOpen"
        :session="session"
        :status="moderationStatus"
        :busy="moderationBusy"
        :awaiting-count="awaitingCount"
        :unidentified-count="unidentifiedCount"
        :reviewable-now="reviewableNow"
        :assigned="assigned"
        :review-steps="reviewSteps"
        :nid="nodeId"
        :can-move="env.canEdit.value"
        :can-delete="env.canDelete.value"
        :title="title"
        :history-href="env.historyHref.value"
        :markdown-href="rawHref"
        @publish="publishPage"
        @save="save"
        @close="closeEditor"
        @deleted="onDeleted"
      />
      <NodeReadActions
        v-else
        :status="moderationStatus"
        :busy="moderationBusy"
        :nid="nodeId"
        :can-edit="env.canEdit.value"
        :can-delete="env.canDelete.value"
        :mode="mode"
        :title="title"
        :history-href="env.historyHref.value"
        :markdown-href="rawHref"
        @revert="revertToPublished"
        @edit="startEdit"
        @deleted="onDeleted"
      />
    </template>
  </ChromeAppNavbar>

  <!-- Phone-only formatting row. At 375px the header holds the sidebar toggle
       and five editing controls; there is no width left for a toolbar in it,
       and an editor that cannot format is not an editor. It sticks under the
       header so it stays reachable while scrolling.
       The block menu sits outside the scrolling half and never leaves the
       screen: a phone has no hover and Nuxt UI hides the drag handle below
       `sm`, so this is the only way to reach a block's actions at all. -->
  <div
    v-if="mode === 'edit' && editorInstance && session"
    class="sticky top-(--ui-header-height) z-20 flex shrink-0 items-center gap-1 border-b border-default bg-default/95 px-2 py-1 backdrop-blur sm:hidden"
  >
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <UEditorToolbar :editor="editorInstance" :items="session.historyItems" class="shrink-0 border-0 bg-transparent" />
      <UEditorToolbar :editor="editorInstance" :items="session.toolbarItems" class="border-0 bg-transparent" />
      <UEditorToolbar :editor="editorInstance" :items="session.toolbarExtendedItems" class="border-0 bg-transparent" />
    </div>
    <!-- The block zone, pinned outside the scrolling half. Same split as the
         navbar strip: what acts on the block sits apart from what writes at
         the caret. -->
    <div class="flex shrink-0 items-center gap-1 border-s border-default ps-1" role="group" aria-label="This block">
      <UEditorToolbar :editor="editorInstance" :items="trailingToolbarItems" class="shrink-0 border-0 bg-transparent" />
      <EditorBlockMenuButton :session="session" class="shrink-0" />
    </div>
    <a
      href="#page-editor"
      data-testid="skip-to-editor"
      class="sr-only shrink-0 z-50 rounded-md bg-primary px-4 py-2 text-sm font-medium text-inverted focus:not-sr-only focus:fixed focus:left-4 focus:top-16"
    >
      Skip to editor
    </a>
  </div>

  <ChromePageBody :pane="mode === 'edit' && !reviewParked ? 'comments' : 'outline'">
    <main id="main-content" tabindex="-1" class="flex-1 focus:outline-none">
      <EditorExternalChangeBanner
        v-if="session?.externalChange.value"
        @reload="session.reload"
      />

      <div class="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
        <article class="min-w-0">
          <ViewPageMetaStrip
            :doc-type="docType"
            :changed="changed"
            :raw-href="rawHref"
            :working-copy="mode === 'edit' && session ? session.markdown : undefined"
            :editable="mode === 'edit'"
            @edit-field="editFrontmatterField"
          >
            <!-- Frontmatter stays a compact strip in edit mode; the schema-driven
                 form expands on demand and collapses back out of the way. -->
            <UButton
              v-if="mode === 'edit'"
              size="sm"
              color="neutral"
              :variant="fmOpen ? 'soft' : 'outline'"
              icon="i-lucide-file-cog"
              :trailing-icon="fmOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="-my-1"
              @click="fmOpen = !fmOpen"
            >
              Details
            </UButton>
          </ViewPageMetaStrip>

          <!-- One heading in both modes, same metrics: read renders it, edit
               makes it the title field's input (EditorTitleHeading). -->
          <EditorTitleHeading
            v-if="mode === 'edit' && session"
            :frontmatter="session.frontmatter"
            :fallback="title"
            :editor="editorInstance"
            :review="titleReview"
            @approve="session.approveItem(TITLE_REVIEW_KEY, $event)"
          />
          <h1
            v-else
            :id="body.titleBlockId || undefined"
            class="okb-page-title mb-3 text-[26px] font-bold leading-[1.15] tracking-tight text-highlighted sm:text-[34px]"
          >
            {{ title }}
          </h1>

          <p v-if="summary" class="mb-5 max-w-[60ch] text-[15px] leading-relaxed text-muted">
            {{ summary }}
          </p>

          <ViewPageAuthorMeta
            :owner="owner"
            :tags="tags"
            :editable="mode === 'edit'"
            @edit-field="editFrontmatterField"
          />

          <EditorFrontmatterForm
            v-if="mode === 'edit' && fmOpen && session"
            :frontmatter="session.frontmatter"
          />

          <!-- Every write puts the title heading first in the stored body
               (server/utils/title-heading.ts), so it is rendered here; hide it
               and the heading above shows the title once. `<MarkdownDocument>`
               wraps the body in its own div, so the heading sits one level down.
               The editor surface never carries it, and mounts inside this same
               prose column: identical x/width/typography in both modes. -->
          <div
            class="page-body relative max-w-[720px] [&>:first-child>h1:first-child]:hidden"
            @click="copyBlockLink"
            @dblclick="editBlockAt"
          >
            <MarkdownDocument v-if="mode !== 'edit'" class="okb-prose" :value="{ nodes: body.nodes }" :components="comarkComponents" />
            <!-- The per-block margin attaches to the rendered body's `id="b-…"`
                 elements: the ℹ that opens a block's card. Read mode only — the
                 editor replaces the body it hangs off, and projects the same
                 provenance onto its own surface as reviewed-by marks instead. -->
            <ViewBlockMargin
              v-if="mode !== 'edit'"
              :provenance="blockProvenance"
              :citations="blockCitations"
              :steps="reviewSteps"
              :viewer-uid="myUid"
              :open-block-id="cardBlockId"
              @open="openBlockCard"
            />
            <NodeEditSurface
              :mode="mode"
              :nid="Number(nid)"
              :steps="enforcedSteps(moderationStatus)"
              :may-moderate="mayModerate(moderationStatus)"
              @session="setSession"
            />
          </div>

          <!-- Phone and tablet: no second column, so the outline follows the
               page as a collapsible. The box is a class and the outline in it
               a query, so both renders agree on the markup while only one
               outline is live. No `<aside>`: the pane owns that one. -->
          <div class="mt-8 lg:hidden">
            <ViewPageToc v-if="!wide" container-selector=".page-body" />
          </div>
        </article>
      </div>

      <!-- One panel for whichever block was asked about; the triggers that open
           it are attached to the rendered body by ViewBlockMargin. -->
      <ViewBlockCard
        v-model:open="cardOpen"
        :block-id="cardBlockId"
        :byline="cardByline"
        :sources="cardSources"
        :trigger="cardTrigger"
        :enforced="cardEnforcedSteps"
        :history-href="env.historyHref.value"
        :viewer-uid="myUid"
      />

      <!-- Below `lg` there is no pane, so the review surface is a slideover. -->
      <EditorReviewDrawer
        v-if="mode === 'edit' && !wide"
        v-model:open="reviewOpen"
        v-bind="reviewSurface"
        v-on="reviewEvents"
      />
    </main>

    <!-- From `lg` the same surface fills the pane the page asked for. -->
    <template #pane>
      <EditorReviewPanel v-bind="reviewSurface" v-on="reviewEvents" />
    </template>
  </ChromePageBody>
</template>
