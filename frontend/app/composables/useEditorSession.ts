import * as Y from 'yjs'
import type { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { buildEditorExtensions } from '~/editor/extensions'
import { BlockIdMinter } from '~/editor/block-id-minter'
import { CollabHistory } from '~/editor/collab-history'
import { ReviewMarks, refreshReviewMarks, sidecarLookup, topLevelBlockPos } from '~/editor/review-marks'
import { CommentMarks, refreshCommentMarks, type ShownThreads } from '~/editor/comment-marks'
import { AgentMarks, refreshAgentMarks } from '~/editor/agent-marks'
import {
  commentsRoot,
  mintCommentId,
  openThreads,
  readThreads,
  recordCommentMessage,
  type CommentAnchor,
  type CommentAssignee,
  type CommentMessage,
  type CommentThread,
} from '#shared/block-comments'
import {
  blockIdOf,
  blockMetaRoot,
  readBlockMeta,
  type BlockMetaMap,
  type Reviewer,
  type ReviewStep,
} from '#shared/page-blocks'
import { mapEditorItems } from '@nuxt/ui/utils/editor'
import { approvalStanding, blockMenuItems, NO_BLOCK_MENU, type BlockMenuNode } from '~/editor/block-menu'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'
import { comarkHandlers, insertToolbarItem, slashItems, tableBubbleItems, tableToolbarItem } from '~/editor/menu-items'
import { setMediaPickerNode } from '~/composables/useMediaLibraryPicker'
import { useDocLinkSearch } from '~/composables/useDocLinkSearch'
import { caretInBlock } from '~/editor/cite-insert'
import type { WritableComputedRef } from 'vue'
import type { FieldValidationApi } from '~/composables/useFieldValidation'
import { TITLE_KEY, type FieldValue } from '~~/server/utils/entity-fields'
import { FALLBACK_COLOR, FALLBACK_NAME, claimsByBlock, collabColor, presenceFromStates, readableInkOn, type AwarenessUser } from '#shared/utils/presence'

interface UserHit { uid: number, name: string }
interface MentionItem { label: string, id: number }

export interface Page {
  id: string
  nid: number
  path: string
  title: string
  body: string
  changed: number
}

/**
 * The collab editor session backing the read page's in-place edit mode:
 * Y.Doc + Hocuspocus provider + TipTap extensions + Drupal commit lane
 * + mention search + save + revert. The page composes chrome around the
 * returned bindings.
 *
 * Page-call shape:
 *   const { page, ... } = await useEditorSession(nid, enforcedSteps, mayModerate)
 *
 * `enforced` is the space's review policy, as the moderation status reports
 * it. The page owns that fetch — it renders the drawer and the publish control
 * off the same answer — and hands it down, so the margin chips and the drawer
 * cannot describe different queues. `mayModerate` rides down from the same
 * answer: it is the ADR 0002 admin exception, without which every review
 * surface here would tell an admin their own writing needs somebody else's
 * eyes.
 *
 * All lifecycle hooks (`onMounted` from useLiveCollab, etc.) register
 * synchronously BEFORE the page fetch awaits — Vue's currentInstance
 * dies across async boundaries inside a nested function, so registering
 * after the await would silently no-op. The page-dependent values
 * (initial Y.Doc seed, name/localKey for hocuspocus) are wired through
 * refs that fill in once the fetch resolves.
 */
export async function useEditorSession(
  nid: Ref<number>,
  enforced: Ref<readonly ReviewStep[]>,
  mayModerate: Ref<boolean>,
) {
  // The media picker's access rides on this page (update access on the
  // node); the menu actions have no route context, so hand the nid over.
  if (import.meta.client) {
    setMediaPickerNode(nid.value)
  }
  // Manual fetch via useAsyncData so we get the data ref synchronously
  // and can defer awaiting until after every lifecycle composable has
  // registered (Vue's currentInstance / Nuxt's implicit context both
  // die across async boundaries inside a nested function).
  //
  // useRequestFetch, not $fetch: the SSR pass must carry the caller's cookie.
  // This route serves the *working copy* (OKB-64), which is a non-default
  // revision the moment a checkpoint has run — anonymous reads of it 401,
  // so a cookie-less SSR fetch turns every page with a pending draft into
  // "Page not found" on a fresh page load.
  const requestFetch = useRequestFetch()
  const pageAsync = useAsyncData<Page | null>(
    `editor-session:${nid.value}`,
    () => requestFetch<Page | null>(`/api/node/${nid.value}`),
  )
  const page = pageAsync.data as Ref<Page | null>

  const ydoc = new Y.Doc()
  const initialChanged = computed(() => page.value?.changed ?? 0)

  const docName = computed(() => `node:${nid.value}`)
  const localKey = computed(() => `openkb-node-${nid.value}`)

  // Identity peers see on carets and per-field editing indicators, derived
  // server-side from the Drupal session via /api/me (useRequestFetch so the
  // SSR pass forwards the caller's cookie). Awareness is peer-published, so a
  // hostile client can still claim any name to its peers — server-derived
  // sourcing removes the accidental wrongness (a stale or hand-edited client
  // value); authenticating awareness claims is OKB-13's identity-model scope.
  // The name fills in below, after the awaits and before mount — awareness
  // publishes the object only from onMounted (useEntityFields, caret config).
  // /api/actor is the superset of /api/me: name + uid + `via` (the agent label
  // for a token session). Name, color and uid all feed awareness; the uid is
  // also half of who the review affordance is drawn for.
  const meAsync = useAsyncData<{ type: string, name: string | null, uid: number | null, via: string | null }>(
    'session-actor',
    () => requestFetch('/api/actor'),
  )
  const collabUser: { name: string, color: string, uid?: number, via?: string } = {
    name: FALLBACK_NAME,
    color: FALLBACK_COLOR,
  }
  // The account a review would be recorded against. Fills in below, after the
  // awaits; `null` until then, and for an anonymous session.
  const signedInUid = ref<number | null>(null)
  /**
   * Who is reading — the account a review would be recorded against, and
   * whether it may moderate past the four-eyes rule (ADR 0002).
   *
   * Both halves only ever draw the affordance: which blocks this reader can
   * sign off, and whether the action is offered. Drupal authorizes the write.
   * Everything else about who wrote what is witnessed away from here — the
   * collab server attributes the ops it applies, Drupal the writes it stores.
   */
  const reviewer = computed<Reviewer>(() => ({
    uid: signedInUid.value,
    isAdmin: mayModerate.value,
  }))
  // The review sidecar as this session sees it: Drupal's flags, sign-offs and
  // contributor records, mirrored into the `blockMeta` Y.Map by the collab
  // server — plus that server's own estimate of the flags its next checkpoint
  // will earn, so a mark follows the edit rather than the save. Observed so the
  // marks re-draw when it moves; never written here.
  const blockMetaMap = blockMetaRoot(ydoc)
  /**
   * The same sidecar as a reactive snapshot — one read of the Y.Map per change,
   * shared by everything that projects it: the gutter marks, the Publish
   * button's count and the review drawer.
   *
   * A ref rather than a getter because the Y.Map is not reactive: nothing in
   * Vue's graph observes it, so a computed over it would never re-evaluate.
   * The observer below is the single place that turns a sidecar change into a
   * render, for all three surfaces at once.
   */
  const blockMeta = ref<BlockMetaMap>({})

  /**
   * The comment threads on this document, as a reactive snapshot of the
   * `comments` Y.Map — a container of its own, beside the sidecar and nothing
   * like it: these are the editors' own words, written by the client that says
   * them, where the sidecar holds only what a server witnessed
   * (`shared/block-comments.ts`). Observed for the same reason the sidecar is:
   * a Y.Map is not part of Vue's reactive graph.
   */
  const commentsMap = commentsRoot(ydoc)

  /**
   * The last click on a block's comment badge — what opens the review drawer
   * at that conversation. Held as a ref rather than acted on here: the drawer
   * belongs to the page (useKbReviewGate), not to the editor session.
   */
  const threadsShownFor = ref<ShownThreads | null>(null)
  const threads = ref<CommentThread[]>([])

  /**
   * Who this session is, as an assignment names them — the same identity the
   * presence strip and the agent commits carry, so a thread handed to editor1's
   * Claude is that account's agent and not the person.
   */
  const me = computed<CommentAssignee | null>(() => {
    const actor = meAsync.data.value
    return actor?.uid
      ? { uid: actor.uid, name: actor.name ?? FALLBACK_NAME, via: actor.via ?? null }
      : null
  })

  const { provider, liveStatus, peers, awarenessStates, synced, deleted: deletedRemotely } = useLiveCollab({
    ydoc,
    name: docName.value,
    localKey: localKey.value,
  })

  /**
   * Signs a block off — an act in the session, not a request from this client.
   *
   * Nothing about the sign-off is this side's to state. Who signed off is the
   * socket's, resolved when it authenticated; the four-eyes rule is Drupal's.
   * So the sign-off goes out as a stateless message: the collaboration server
   * records it under that account and carries it to Drupal inside the
   * checkpoint it triggers, which is also the save that persists it.
   *
   * Drupal's answer arrives in `_meta.review` — a refusal in its own words
   * below, the recorded sign-offs as marks re-projected from the sidecar that
   * checkpoint re-read.
   *
   * One step per sign-off, and every control names the one its block is pending
   * on.
   */
  const approveItem = (item: string, step: ReviewStep) => {
    if (!provider.value || liveStatus.value !== 'live') {
      // A stateless message on a dead socket is dropped without a word, and a
      // sign-off that quietly did not happen is the one outcome a reviewer
      // must never be left with.
      toast.add({
        title: 'Sign-off not sent',
        description: 'It goes out over the live session, which is not connected right now.',
        icon: 'i-lucide-wifi-off',
        color: 'error',
      })
      return
    }
    provider.value.sendStateless(JSON.stringify({ type: 'review.approve', item, step }))
  }

  /**
   * The refusals of this reader's own sign-offs, in Drupal's words.
   *
   * Every peer sees the whole answer — it rides the shared document — so each
   * entry is matched against the account this client is signed in as. Drupal
   * decides between two four-eyes refusals that ask for different things: a
   * second reader, or an identified edit.
   */
  const reviewMeta = ydoc.getMap('_meta')
  let lastReviewAt = 0
  const onReviewAnswer = () => {
    const answer = reviewMeta.get('review') as
      { at?: number, refused?: Array<{ uid: number, reason: string }> } | undefined
    const at = Number(answer?.at ?? 0)
    if (!answer || at <= lastReviewAt) return
    lastReviewAt = at
    for (const entry of answer.refused ?? []) {
      if (entry.uid !== collabUser.uid) continue
      toast.add({
        title: 'Sign-off refused',
        description: entry.reason,
        icon: 'i-lucide-lock',
        color: 'error',
      })
    }
  }
  onMounted(() => {
    // The answer is in the document, so it outlives the session that earned it
    // — the snapshot store holds it across a restart. Taking its clock before
    // observing is what keeps an unrelated `_meta` write from re-raising
    // yesterday's refusal.
    lastReviewAt = Number((reviewMeta.get('review') as { at?: number } | undefined)?.at ?? 0)
    reviewMeta.observeDeep(onReviewAnswer)
  })
  onBeforeUnmount(() => reviewMeta.unobserveDeep(onReviewAnswer))

  // Entity fields share the session Y.Doc with the body — same provider, same
  // offline mirror. The form that renders them is OKB-47; these bindings are
  // the seam it plugs into.
  const {
    fields: entityFields,
    seeded: fieldsSeeded,
    field: entityField,
    setField: setEntityField,
    peersByField: fieldPeers,
    focusField: focusEntityField,
  } = useEntityFields({
    ydoc,
    provider,
    user: collabUser,
  })

  // Local field edits feed the dry-run validation lane (OKB-53). Assigned
  // right below — the binding wrapper only needs it by call time.
  let validation: FieldValidationApi | null = null

  // Memoized like useEntityFields' own models: the template calls field(key)
  // inside its render, and a fresh computed per render would drop its cache.
  const touchingModels = new Map<string, WritableComputedRef<FieldValue>>()

  /**
   * The session field binding, plus a validation touch on *local* writes.
   * The unchanged-value guard mirrors setField's own, so a round-tripped
   * remote update (peer edit → ref → input → back here) neither re-broadcasts
   * nor triggers a dry run — peers validate their own edits.
   */
  function touchingField(key: string): WritableComputedRef<FieldValue> {
    let model = touchingModels.get(key)
    if (!model) {
      const inner = entityField(key)
      model = computed({
        get: () => inner.value,
        set: (value) => {
          if (JSON.stringify(inner.value ?? null) === JSON.stringify(value ?? null)) return
          inner.value = value
          validation?.touch(key)
        },
      })
      touchingModels.set(key, model)
    }
    return model
  }

  // The schema-driven frontmatter form (OKB-47) plugs into those bindings.
  // Its useFetch is registered here — before the page await — so it keeps
  // Nuxt's async-data context, like every other lifecycle-bound composable.
  const frontmatter = useFrontmatterForm({
    seeded: fieldsSeeded,
    field: touchingField,
    peersByField: fieldPeers,
    focusField: focusEntityField,
  })

  // Called before the page await: it holds a useFetch, which needs Nuxt's
  // async-data context.
  const { docItems, searchDocs, docLabel } = useDocLinkSearch()

  const fieldValidation = useFieldValidation({
    nid,
    model: frontmatter.model,
    values: () => ({ ...entityFields.value }),
  })
  validation = fieldValidation

  const editorRef = ref<{ editor: import('@tiptap/core').Editor } | null>(null)

  // A sign-off changes the sidecar and not the document, so no transaction
  // reaches the editor when a PEER reviews a block — observe the Y.Map and
  // re-project. (The local action refreshes itself from inside the command.)
  // Registered here, before this composable's awaits: `onBeforeUnmount` after
  // an await would find no currentInstance and silently never run.
  const refreshMarks = () => {
    blockMeta.value = readBlockMeta(ydoc)
    const view = editorRef.value?.editor?.view
    if (view) refreshReviewMarks(view)
  }
  blockMetaMap.observe(refreshMarks)
  onBeforeUnmount(() => blockMetaMap.unobserve(refreshMarks))

  // The page fetches the policy, so it can land after the editor is open. The
  // lookup reads it live, but nothing else would rebuild on it — and a stale
  // `mayModerate` is not a cosmetic lag: it marks an admin's own block as
  // somebody else's to sign off. So re-project when either input moves.
  watch([enforced, mayModerate], refreshMarks)

  // Same shape for the conversation: a comment a peer writes moves no document
  // content either, so its marks have nothing else to redraw them.
  const refreshComments = () => {
    threads.value = readThreads(ydoc)
    const view = editorRef.value?.editor?.view
    if (view) refreshCommentMarks(view)
  }
  commentsMap.observe(refreshComments)
  onBeforeUnmount(() => commentsMap.unobserve(refreshComments))

  const {
    status: commitStatus,
    error: commitError,
    lastSavedAt,
    externalChange,
    commitFieldErrors,
    markDirty,
    save: saveToHistory,
  } = useDrupalCommitState({
    ydoc,
    nid,
    initialChanged,
  })

  // A fresh commit-side 422 mapping is authoritative — it just validated the
  // exact payload — so it reclaims every slot from the advisory lane. The
  // empty transition (a successful commit clearing the errors) leaves the
  // lane alone: a dry run pending during the save stays scheduled.
  watch(commitFieldErrors, (byName) => {
    if (Object.keys(byName).length > 0) fieldValidation.reset()
  })

  // Per-field messages → the form's error slots: the commit path's 422
  // mapping (`_meta.commit_error`, JSON:API-name-keyed, translated to
  // frontmatter keys — the title is a base field, outside the model) overlaid
  // with the type-time dry-run lane (OKB-53), which owns the slot of any
  // field edited since. Same slots, so both error kinds render identically.
  watch([commitFieldErrors, frontmatter.model, fieldValidation.liveErrors], ([byName, model, live]) => {
    const keyByName = new Map(model.map(f => [f.name, f.key]))
    keyByName.set(TITLE_KEY, TITLE_KEY)
    const mapped: Record<string, string[]> = {}
    for (const [name, messages] of Object.entries(byName)) {
      const key = keyByName.get(name)
      if (key) mapped[key] = messages
    }
    frontmatter.errors.value = { ...mapped, ...live }
  }, { immediate: true })

  // Render-ready peer list for the presence strip: same awareness states
  // that feed the peer count, mapped + self-flagged (self sorts first).
  const presence = computed(() =>
    presenceFromStates(awarenessStates.value, provider.value?.awareness?.clientID ?? null))

  // Which blocks peers say they are working on (OKB-164). A claim moves no
  // document content, so the marks are re-projected from here rather than by a
  // transaction — same shape as the sidecar's refresh above.
  //
  // Keyed on the claims alone, not on the awareness states: those change on
  // every caret nudge of every peer, and each refresh costs a dispatch.
  const claimedBlocks = computed(() =>
    claimsByBlock(awarenessStates.value, provider.value?.awareness?.clientID ?? null))
  watch(
    () => Object.entries(claimedBlocks.value)
      .map(([id, peers]) => `${id}:${peers.map(peer => peer.clientId).join(',')}`)
      .sort().join('|'),
    () => {
      const view = editorRef.value?.editor?.view
      if (view) refreshAgentMarks(view)
    },
  )

  const savedAgo = useRelativeTime(lastSavedAt)
  const toast = useToast()

  useBeforeUnloadGuard(computed(() => commitStatus.value === 'dirty' || commitStatus.value === 'saving'))

  // Block the page setup until the page is loaded — the page renders
  // `v-if="page"`, so without this await the SSR pass would skip the
  // entire body. All lifecycle hooks above (useLiveCollab, etc.) and
  // composables that read `useNuxtApp()` (useToast) MUST be registered
  // before this await — Vue's currentInstance and Nuxt's implicit
  // context both die across async boundaries inside a nested function.
  await Promise.all([pageAsync, meAsync])
  // A failed identity fetch is not fatal — the editor still works, peers just
  // see the generic label until the next session.
  if (meAsync.data.value?.name) collabUser.name = meAsync.data.value.name
  // The account behind this peer: its stable color, shared by carets, per-field
  // indicators and the presence strip, and the uid the strip's avatar links to.
  if (meAsync.data.value?.uid) {
    collabUser.uid = meAsync.data.value.uid
    collabUser.color = collabColor(meAsync.data.value.uid)
  }
  // Publish `via` so peers name the agent by its owner: "name via claude".
  if (meAsync.data.value?.via) collabUser.via = meAsync.data.value.via
  signedInUid.value = meAsync.data.value?.uid ?? null
  // An unreachable backend must not read as "this page does not exist" —
  // pass the server's own status through so the error page offers a retry
  // instead of a dead end. This runs before any collab session exists; once
  // the editor is live, backend failures stay in the banner/chip lane.
  if (pageAsync.error.value) {
    const status = Number((pageAsync.error.value as { statusCode?: number }).statusCode) || 503
    // `fatal` is what makes this surface as the branded error page on a
    // client-side navigation too — without it Nuxt aborts the navigation
    // silently and the reader is left on the previous page.
    throw createError({ statusCode: status, statusMessage: 'Page unavailable', fatal: true })
  }
  if (!page.value) {
    throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
  }

  /**
   * Commit to Drupal history. Returns whether the commit landed — the page
   * owns what happens next.
   *
   * The committed document stays as it is. A session holding the editor must
   * never empty the fragment: ProseMirror always has a blank paragraph, and
   * the next transaction writes it back as content. Seeding paths read that
   * as hydrated, so nothing re-seeds and later peers get a blank page.
   * `_meta.last_commit_hash` already records that fragment and Drupal agree.
   */
  async function save(): Promise<boolean> {
    await saveToHistory()
    if (commitStatus.value !== 'saved') return false
    // Saving writes a revision and nothing else: the live page moves when
    // somebody publishes.
    toast.add({
      title: 'Saved as draft',
      description: `"${page.value!.title}" is in the page's history; Publish puts it on the live page.`,
      icon: 'i-lucide-check',
      color: 'success' as const,
    })
    return true
  }

  const extensions = computed(() => [
    ...buildEditorExtensions(),
    Collaboration.configure({ document: ydoc }),
    CollaborationCaret.configure({
      provider: provider.value,
      user: collabUser,
      // Same shape the extension renders by default, with the name painted in
      // an ink the peer's own colour can carry.
      render: (user: AwarenessUser) => {
        const color = user.color ?? FALLBACK_COLOR
        const caret = document.createElement('span')
        caret.classList.add('collaboration-carets__caret')
        caret.style.borderColor = color
        const label = document.createElement('div')
        label.classList.add('collaboration-carets__label')
        label.style.backgroundColor = color
        label.style.color = readableInkOn(color)
        label.textContent = user.name ?? FALLBACK_NAME
        caret.append(label)
        return caret
      },
    }),
    // Keeps undo redoable across the plugin-view teardowns Tiptap's own menus
    // cause. Mounted beside Collaboration, whose UndoManager it re-asserts.
    CollabHistory,
    // Keeps every touched block on a stable id. Ids are content; nothing else
    // about a block is this side's to write.
    BlockIdMinter,
    // Projects the sidecar's review standing onto the surface, and owns the
    // action that asks Drupal to clear it. Reads the Y.Map live — the
    // extension holds no copy, and writes none.
    ReviewMarks.configure({
      lookup: blockId => sidecarLookup(blockMeta.value, enforced.value, reviewer.value)(blockId),
      approve: (item, step) => approveItem(item, step),
    }),
    // Marks the blocks a conversation is open on, and owns the action that
    // starts one. The thread itself is composed in the drawer — nothing is
    // written until there is a message.
    CommentMarks.configure({
      threads: () => readThreads(ydoc),
      openThread: (blockId, anchor) => { commentDraft.value = { blockId, anchor } },
      showThreads: (blockId, threadId) => {
        threadsShownFor.value = { blockId, threadId, at: Date.now() }
      },
      startThread: pos => commentOnSelection(pos),
    }),
    // Shows where an agent says it is working. Reads awareness live; claims no
    // block and blocks nothing.
    AgentMarks.configure({
      lookup: blockId => claimedBlocks.value[blockId] ?? [],
      viewerUid: () => signedInUid.value,
    }),
  ])

  // A session the collab server rejected must not accept local keystrokes:
  // the doc would fork in isolation — no presence, no sync, and nothing
  // ever committed. Lock the editor instead; it unlocks when a websocket
  // retry authenticates (useLiveCollab's onAuthenticated resets the status,
  // e.g. after signing in in another tab).
  // `emitUpdate: false` and the isEditable guard both matter: setEditable
  // fires the editor's 'update' event by default, which markDirty listens to —
  // an unguarded call here marks a freshly-opened, untouched doc as having
  // unsaved changes and re-dirties the state mid-save, aborting saveAndExit's
  // post-commit toast/navigation.
  watchEffect(() => {
    const editor = editorRef.value?.editor
    if (!editor) return
    const editable = !isAuthFailedStatus(liveStatus.value)
    if (editor.isEditable !== editable) editor.setEditable(editable, false)
  })

  /**
   * The id of the block holding the caret, mirrored onto a ref because
   * `selectedBlock()` reads live editor state that no ref invalidates.
   */
  const caretBlockId = ref<string | null>(null)

  /** Whether the caret sits in a table — what the bubble's table group keys on. */
  const caretInTable = ref(false)

  // Hydration: y-prosemirror owns the doc, so seed the Y.Doc directly
  // by applying a binary update from a temporary Y.Doc holding the
  // initial markdown, parsed sync + DOM-free by the shared engine — the
  // live editor observes the update and renders.
  let hydrated = false
  watchEffect(() => {
    if (hydrated) return
    const editor = editorRef.value?.editor
    if (!synced.value || !editor || !page.value) return
    hydrated = true
    const initialBody = page.value.body ?? ''
    const fragment = ydoc.getXmlFragment('default')
    if (fragment.length === 0 && initialBody) {
      const json = parseMarkdownToJson(initialBody)
      const seedDoc = prosemirrorJSONToYDoc(editor.schema, json, 'default')
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seedDoc))
    }
    editor.on('update', markDirty)
    const trackCaret = () => {
      const node = selectedBlock()?.node
      caretBlockId.value = node ? blockIdOf(node) : null
      caretInTable.value = editor.isActive('table')
    }
    editor.on('selectionUpdate', trackCaret)
    // Also on doc change: BlockIdMinter can give the caret's block an id it
    // did not have.
    editor.on('update', trackCaret)
    trackCaret()
  })

  /**
   * Drop the Y.Doc fragment and re-seed from Drupal's last committed
   * markdown via the same path as initial hydration. Commit lane returns
   * to 'saved' (or 'never-saved' if there's no commit yet).
   */
  function revert() {
    const editor = editorRef.value?.editor
    if (!editor || !page.value) return
    const initialBody = page.value.body ?? ''
    const fragment = ydoc.getXmlFragment('default')
    Y.transact(ydoc, () => {
      if (fragment.length > 0) fragment.delete(0, fragment.length)
      if (initialBody) {
        const json = parseMarkdownToJson(initialBody)
        const seedDoc = prosemirrorJSONToYDoc(editor.schema, json, 'default')
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seedDoc))
      }
    })
    commitStatus.value = lastSavedAt.value ? 'saved' : 'never-saved'
    commitError.value = null
  }

  function reload() { window.location.reload() }

  const mentionQuery = ref('')
  const mentionItems = ref<MentionItem[]>([])
  let mentionAbort: AbortController | null = null
  let mentionTimer: ReturnType<typeof setTimeout> | null = null

  watch(mentionQuery, (q) => {
    if (mentionTimer) clearTimeout(mentionTimer)
    mentionTimer = setTimeout(async () => {
      if (mentionAbort) mentionAbort.abort()
      mentionAbort = new AbortController()
      if (!q) { mentionItems.value = []; return }
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, {
          signal: mentionAbort.signal,
          credentials: 'same-origin',
        })
        if (!res.ok) { mentionItems.value = []; return }
        const data = await res.json() as { users: UserHit[] }
        mentionItems.value = (data.users ?? []).map(u => ({ label: u.name, id: u.uid }))
      }
      catch { /* aborted or network */ }
    }, 120)
  })

  function attachFile() {
    toast.add({
      title: 'Attach file',
      description: 'Attachments land in beta2.',
      icon: 'i-lucide-paperclip',
    })
  }

  /**
   * The thread being composed — a block and, when the comment was opened on a
   * passage, the range it is about. Held here rather than written on the spot
   * because a thread with no message is not a thread: nothing lands in the
   * document until there is something to say.
   */
  const commentDraft = ref<{ blockId: string, anchor: CommentAnchor | null } | null>(null)

  /** Writes one message into a thread, under a key of its own. */
  function writeMessage(
    blockId: string,
    threadId: string,
    said: Pick<CommentMessage, 'text' | 'anchor' | 'resolved' | 'assignee'>,
  ): void {
    recordCommentMessage(ydoc, blockId, threadId, mintCommentId('m'), {
      uid: reviewer.value.uid,
      name: collabUser.name,
      at: Date.now(),
      ...said,
    })
  }

  /**
   * Posts the drafted thread's opening message and clears the draft. An
   * assignment is a second message, in the same transaction: two would reach a
   * watching agent as two events, the first of them assigned to nobody.
   */
  function postComment(text: string, assignee: CommentAssignee | null = null): void {
    const draft = commentDraft.value
    if (!draft || !text.trim()) return
    const threadId = mintCommentId('c')
    ydoc.transact(() => {
      writeMessage(draft.blockId, threadId, {
        text: text.trim(),
        ...(draft.anchor ? { anchor: draft.anchor } : {}),
      })
      if (assignee) writeMessage(draft.blockId, threadId, { assignee })
    })
    commentDraft.value = null
  }

  /** Adds a reply to an existing thread. */
  function replyToComment(blockId: string, threadId: string, text: string): void {
    if (!text.trim()) return
    writeMessage(blockId, threadId, { text: text.trim() })
  }

  /**
   * Resolves or reopens a thread. Recorded as another message rather than as
   * an edit of an existing one, so a concurrent reply and a resolve merge
   * instead of one overwriting the other.
   */
  function setCommentResolved(blockId: string, threadId: string, resolved: boolean): void {
    writeMessage(blockId, threadId, { resolved })
  }

  /** Hands a thread to somebody, or to nobody — the latest such message wins. */
  function setCommentAssignee(
    blockId: string,
    threadId: string,
    assignee: CommentAssignee | null,
  ): void {
    writeMessage(blockId, threadId, { assignee })
  }

  /**
   * Puts the cursor in a block and scrolls it into view — how the review
   * drawer hands a blocker over to the editor. A row whose block has since
   * gone is a no-op rather than a thrown position.
   */
  function goToBlock(pos: number) {
    const editor = editorRef.value?.editor
    if (!editor || pos >= editor.state.doc.content.size) return
    editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run()
  }

  /**
   * Signs the local actor off on the caret's block, on the step it is pending
   * on ({@link caretStanding}) — the step the margin checkmark clears too. The
   * toolbar's ✔ and the block menu's item both reach here. Only id-bearing
   * blocks are offered it: comark 0.5 carries no id on a container.
   */
  function markSelectedBlockReviewed() {
    const editor = editorRef.value?.editor
    const step = caretStanding.value.step
    if (!editor || !step) return
    // Refused before the click: the control carries the reason already, so
    // there is nothing left to say and nothing to ask Drupal.
    if (caretStanding.value.refusal) return
    editor.chain().focus().approveBlockAtCursor(step).run()
  }

  /**
   * Opens a comment thread on the selection, or on the block holding the
   * cursor. `blockPos` names the block the margin's control sits beside; the
   * words marked inside it still decide the passage. Refuses on a container
   * block for the same reason a sign-off does: comark 0.5 carries no id there,
   * so there is nothing stable to anchor to.
   */
  function commentOnSelection(blockPos?: number) {
    const editor = editorRef.value?.editor
    if (!editor) return
    if (reviewer.value.uid == null) {
      toast.add({
        title: 'Not signed in',
        description: 'Comments are recorded against your account.',
        icon: 'i-lucide-lock',
        color: 'error',
      })
      return
    }
    // No `focus()` in this chain, unlike the sign-off's: the composer that
    // opens next is where the editor is going, and TipTap's focus lands on the
    // ProseMirror surface a tick later — which the drawer, a non-modal
    // slide-over, reads as the reader having interacted outside it and closes
    // on. The command reads the stored selection, so it needs no focus.
    if (!editor.chain().commentOnSelection(blockPos).run()) {
      toast.add({
        title: 'Nothing to comment on here',
        description: 'Lists, tables and quotes carry no block id yet — put the cursor in a paragraph or heading.',
        icon: 'i-lucide-info',
      })
    }
  }

  // --- The block menu on the drag handle ------------------------------------

  /**
   * The block the drag handle last floated over, and the one its menu is open
   * on. Two refs because the menu must not re-read the hover once it is open:
   * the pointer is on the menu by then, and on its way there it crosses other
   * blocks.
   */
  const hoveredBlock = ref<BlockMenuNode | null>(null)
  const blockMenuAnchor = ref<BlockMenuNode | null>(null)

  /**
   * The block the menu acts on, read off the live selection.
   *
   * Not off the position the menu opened at: in a collab session a peer
   * transaction shifts positions under an open menu, and ProseMirror remaps
   * the `NodeSelection` for us while a stored integer would go stale.
   */
  function selectedBlock() {
    const state = editorRef.value?.editor?.state
    if (!state) return null
    const pos = topLevelBlockPos(state)
    if (pos === null) return null
    const node = state.doc.nodeAt(pos)
    return node ? { pos, node } : null
  }

  /**
   * The document as it stands in the editor, in the `.md` body form — the
   * working copy, which no address serves until a commit lands.
   */
  function markdown(): string {
    const doc = editorRef.value?.editor?.state.doc
    return doc ? serializeDocToMarkdown(doc) : ''
  }

  /**
   * What was last cut or copied here, as markdown.
   *
   * The system clipboard is the better home for it — a block copied here then
   * pastes into another tab, and anything copied elsewhere pastes in. But it
   * only exists in a secure context and only answers a read where the browser
   * allows one, and a menu item that does nothing at all there would be worse
   * than one that moves blocks within the session. So every take is kept here
   * too, and Paste falls back to it.
   */
  const blockBuffer = ref<string | null>(null)

  /** Said when the system clipboard is out of reach, so the toast is honest. */
  const OFF_CLIPBOARD = 'Kept for Paste below — this page cannot reach the system clipboard.'

  /**
   * Takes the selected block as markdown — with its `{#id}`, so what is pasted
   * carries the block's identity, its review and its comments with it.
   */
  async function takeBlock(): Promise<'none' | 'buffer' | 'clipboard'> {
    const node = selectedBlock()?.node
    if (!node) return 'none'
    const markdown = serializeDocToMarkdown({ type: 'doc', content: [node.toJSON()] })
    blockBuffer.value = markdown
    try {
      await navigator.clipboard.writeText(markdown)
      return 'clipboard'
    }
    catch {
      return 'buffer'
    }
  }

  async function copyBlock() {
    const taken = await takeBlock()
    if (taken === 'none') return
    toast.add({
      title: 'Block copied',
      icon: 'i-lucide-clipboard-check',
      color: 'success',
      ...(taken === 'buffer' ? { description: OFF_CLIPBOARD } : {}),
    })
  }

  /**
   * Copy, then remove. The block is read off the selection again after the
   * clipboard has been awaited — focusing the editor turns a node selection
   * into a text one, and a peer's edit can shift the position under it.
   */
  async function cutBlock() {
    const taken = await takeBlock()
    if (taken === 'none') return
    const block = selectedBlock()
    if (!block) return
    editorRef.value?.editor?.chain().focus()
      .deleteRange({ from: block.pos, to: block.pos + block.node.nodeSize })
      .run()
    toast.add({
      title: 'Block cut',
      icon: 'i-lucide-scissors',
      color: 'success',
      ...(taken === 'buffer' ? { description: OFF_CLIPBOARD } : {}),
    })
  }

  /** The clipboard, or what this session last took when the browser refuses a read. */
  async function clipboardMarkdown(): Promise<string | null> {
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim()) return text
    }
    catch {
      // No read permission (or no clipboard at all) — the buffer answers.
    }
    return blockBuffer.value
  }

  /** Puts the clipboard's markdown in as blocks of their own, below this one. */
  async function pasteBlockBelow() {
    const markdown = await clipboardMarkdown()
    if (!markdown?.trim()) {
      toast.add({ title: 'Nothing to paste', icon: 'i-lucide-info' })
      return
    }
    const editor = editorRef.value?.editor
    const block = selectedBlock()
    if (!editor || !block) return
    const content = parseMarkdownToJson(markdown).content
    if (!content?.length) return
    editor.chain().focus().insertContentAt(block.pos + block.node.nodeSize, content).run()
  }

  /**
   * A fresh block below this one, with the slash menu open on it.
   *
   * The `/` has to be typed into a focused editor: the suggestion plugin goes
   * active off the transaction that inserts the character with the caret
   * inside the block, and a block inserted whole — the caret landing after it
   * — leaves it inert. It also has to happen after the menu is gone, because
   * closing a dropdown hands focus back to the control that opened it, which
   * takes it straight out of the editor again.
   */
  function insertBlockBelow() {
    runAfterMenuClose(() => {
      const editor = editorRef.value?.editor
      const block = selectedBlock()
      if (!editor || !block) return
      const at = block.pos + block.node.nodeSize
      editor.chain().focus()
        .insertContentAt(at, { type: 'paragraph' })
        .setTextSelection(at + 1)
        .insertContent('/')
        .run()
    })
  }

  /**
   * The citation picker, opened where the author was typing.
   *
   * Types the same `[^` a hand-typed one does. Opening the menu selects the
   * whole block, so the caret comes from the memory ({@link caretInBlock}); a
   * caret that was in another block falls back to the end of this one, inside
   * it, because a citation is inline and the position after the block is not.
   * Deferred until the menu is gone for the same reason `insertBlockBelow` is:
   * a closing dropdown hands focus back to the control that opened it.
   */
  function citeFromBlockMenu() {
    runAfterMenuClose(() => {
      const editor = editorRef.value?.editor
      const block = selectedBlock()
      if (!editor || !block) return
      const at = caretInBlock(editor.state, block.pos) ?? block.pos + block.node.nodeSize - 1
      editor.chain().focus().setTextSelection(at).insertContent('[^').run()
    })
  }

  /**
   * The same, from the block menu — deferred until the menu is gone.
   *
   * The composer opens in the review drawer, a non-modal slide-over: a
   * `focusin` outside it dismisses it. A closing dropdown hands focus back to
   * the control that opened it, which is outside — so run without it, and the
   * drawer stays up.
   */
  function commentFromBlockMenu() {
    runAfterMenuClose(commentOnSelection)
  }

  /**
   * The open menu's items, resolved against the live editor.
   *
   * `mapEditorItems` is what turns each `kind` into an executable entry and
   * reads its enabled state off `editor.can()`, so the schema — not this
   * module — decides which "Turn into" target is reachable and where Move
   * up/down stop.
   */
  const blockMenu = computed(() => {
    const editor = editorRef.value?.editor
    const anchor = blockMenuAnchor.value
    if (!editor || !anchor) return NO_BLOCK_MENU
    const node = selectedBlock()?.node
    const id = node ? blockIdOf(node) : null
    return mapEditorItems(editor, blockMenuItems({
      block: anchor,
      meta: id ? blockMeta.value[id] : undefined,
      steps: enforced.value,
      reviewer: reviewer.value,
      openThreads: id ? openThreads(threads.value, id).length : 0,
    }, {
      cut: () => void cutBlock(),
      copy: () => void copyBlock(),
      paste: () => void pasteBlockBelow(),
      insertBelow: insertBlockBelow,
      cite: citeFromBlockMenu,
      review: markSelectedBlockReviewed,
      comment: commentFromBlockMenu,
    }), comarkHandlers)
  })

  /**
   * Pins the handle in place for as long as its menu is open. The drag-handle
   * plugin otherwise hides on the first mouse move off the block, and on any
   * keypress, tearing the anchor out from under the open menu.
   */
  function lockDragHandle(locked: boolean) {
    const view = editorRef.value?.editor?.view
    view?.dispatch(view.state.tr.setMeta('lockDragHandle', locked))
  }

  /**
   * Opens the menu on the block the handle is floating over.
   *
   * The block comes from the handle's `hover` stream rather than from the
   * click that opens the menu: reka's dropdown trigger takes the Enter keydown
   * and calls `preventDefault()`, so a keyboard open never produces a click at
   * all — and the handle's own click is what would otherwise have named the
   * block and selected it. Selecting it here is therefore not a duplicate of
   * what the handle does; it is the only thing that does it on the keyboard
   * path, and every item that reads the selection (turn into, review, comment)
   * depends on it.
   */
  function openBlockMenu() {
    const block = hoveredBlock.value
    afterMenuClose = null
    if (!block) return
    blockMenuAnchor.value = block
    editorRef.value?.editor?.commands.setNodeSelection(block.pos)
    lockDragHandle(true)
  }

  /**
   * Opens the same menu on the block holding the caret — the touch and
   * keyboard route to it.
   *
   * The drag handle is a pointer affordance: it needs hover to appear, and
   * Nuxt UI's theme hides it outright below `sm`, so on a phone there is no
   * handle to reach for. This anchors on the selection instead, which a tap
   * into a block already sets.
   */
  function openBlockMenuAtCursor() {
    const editor = editorRef.value?.editor
    const block = selectedBlock()
    afterMenuClose = null
    if (!editor || !block) {
      blockMenuAnchor.value = null
      return
    }
    blockMenuAnchor.value = {
      pos: block.pos,
      type: block.node.type.name,
      level: block.node.attrs?.level as number | undefined,
    }
    editor.commands.setNodeSelection(block.pos)
  }

  /**
   * What to run once the menu is gone — for the item that leaves the caret in
   * the editor, which a closing dropdown would otherwise take away.
   */
  let afterMenuClose: (() => void) | null = null
  function runAfterMenuClose(action: () => void) {
    afterMenuClose = action
  }

  /**
   * Takes the focus the closing menu is about to hand back to its trigger,
   * and runs the queued action with it.
   *
   * The blur is not cosmetic: the slash menu dismisses itself whenever the
   * editor loses focus, which is what made "Insert below" open a menu that
   * vanished on the same tick. With nothing queued the default holds and focus
   * returns to the trigger, which is what a keyboard user leaving by Escape
   * needs.
   */
  function onBlockMenuCloseAutoFocus(event: Event) {
    const action = afterMenuClose
    if (!action) return
    afterMenuClose = null
    event.preventDefault()
    action()
  }

  // The anchor deliberately outlives the close: the items are still rendered
  // while the menu fades out, and it is replaced on the next open anyway.
  function closeBlockMenu() {
    lockDragHandle(false)
  }

  /**
   * Selects a whole block and leaves the focus in the editor — the gutter
   * beside a block is what runs this.
   *
   * A node selection is what the copy/cut/paste shortcuts need to address a
   * component block (a callout, a table) as one thing; clicking into it only
   * ever puts a caret in the text it contains.
   */
  function selectBlockAt(pos: number) {
    editorRef.value?.editor?.chain().setNodeSelection(pos).focus().run()
  }

  /**
   * Keeps the caret where an insert put it: the `[[` and `[^` pickers close on
   * editor blur, and a closing dropdown gives the focus back to its trigger. A
   * menu left without inserting never focused the editor, so the focus goes
   * back to the (+) button, which is what a keyboard user needs.
   */
  function onInsertMenuCloseAutoFocus(event: Event) {
    if (editorRef.value?.editor?.isFocused) event.preventDefault()
  }

  // The (+) insert menu. It is the one insert control that survives the
  // tightest toolbar collapse (B · I · ＋).
  const insertMenuItem = {
    ...insertToolbarItem,
    content: { onCloseAutoFocus: onInsertMenuCloseAutoFocus },
  }

  // Undo / redo. The session runs Collaboration, so these are the Y.js
  // UndoManager's — they undo this user's own changes and never a peer's. The
  // editor mounts with StarterKit's `history`/`undoRedo` off, which is what
  // keeps a second history from competing for the same keystrokes.
  const historyItems = [
    [
      { kind: 'undo', icon: 'i-lucide-undo-2', 'aria-label': 'Undo', tooltip: { text: 'Undo' } },
      { kind: 'redo', icon: 'i-lucide-redo-2', 'aria-label': 'Redo', tooltip: { text: 'Redo' } },
    ],
  ]

  // Formatting toolbar, in two halves so the collapse can drop the second one
  // and leave B · I · ＋. Core survives every width; extended (headings, lists,
  // quote, image, table) yields first.
  const toolbarItems = [
    [
      { kind: 'mark', mark: 'bold', icon: 'i-lucide-bold', 'aria-label': 'Bold', tooltip: { text: 'Bold' } },
      { kind: 'mark', mark: 'italic', icon: 'i-lucide-italic', 'aria-label': 'Italic', tooltip: { text: 'Italic' } },
    ],
    [insertMenuItem],
  ]
  const toolbarExtendedItems = [
    [
      { kind: 'heading', level: 2, icon: 'i-lucide-heading-2', 'aria-label': 'Heading 2', tooltip: { text: 'Heading 2' } },
      { kind: 'bulletList', icon: 'i-lucide-list', 'aria-label': 'Bullet list', tooltip: { text: 'Bullet list' } },
      { kind: 'blockquote', icon: 'i-lucide-quote', 'aria-label': 'Quote', tooltip: { text: 'Quote' } },
    ],
    [
      { kind: 'image', icon: 'i-lucide-image', 'aria-label': 'Image from media library', tooltip: { text: 'Image from media library' } },
    ],
    [tableToolbarItem],
  ]

  /**
   * The same extended set as one menu, for a row too short to lay it out.
   * `UEditorToolbar` renders an item carrying `items` as a dropdown. The table
   * actions are spread in flat, so every command is one click deep.
   */
  const toolbarOverflowItems = [
    [{
      icon: 'i-lucide-ellipsis',
      'aria-label': 'More formatting',
      tooltip: { text: 'More formatting' },
      items: toolbarExtendedItems.flat().flatMap(item =>
        ('items' in item ? item.items : [{ ...item, label: item['aria-label'] }])),
    }],
  ]

  /**
   * Where the caret's block stands with the review policy. The block menu's
   * item reads the same standing over the same sidecar.
   */
  const caretStanding = computed(() => approvalStanding(
    caretBlockId.value ? blockMeta.value[caretBlockId.value] : undefined,
    enforced.value,
    reviewer.value,
  ))

  // The per-block tools beside the toolbar. Both act on the block holding the
  // cursor. Inserts live in (+), attach in the ⋯ menu. Comment is always
  // shown; mark-reviewed only where a step is pending, since that is the only
  // state the sign-off has something to record.
  //
  // A sign-off the rule refuses says so here too, on the margin checkmark's
  // pattern: `aria-disabled` with the reason as the tooltip, the click turned
  // down in the handler. Nuxt UI's own `disabled` drops the tooltip, which is
  // the whole of what the control has to say.
  const toolbarTrailingItems = computed(() => [
    [
      ...(caretStanding.value.step
        ? [{
            icon: 'i-lucide-badge-check',
            tooltip: { text: caretStanding.value.refusal ?? 'Mark this block reviewed' },
            'aria-label': 'Mark this block reviewed',
            ...(caretStanding.value.refusal ? { 'aria-disabled': 'true' } : {}),
            onClick: markSelectedBlockReviewed,
          }]
        : []),
      {
        icon: 'i-lucide-message-square-plus',
        tooltip: { text: 'Comment on this block' },
        'aria-label': 'Comment on this block',
        onClick: () => commentOnSelection(),
      },
    ],
  ])

  // Bubble toolbar: selection ops from toolbarItems, plus Comment on the
  // passage — and, with the caret in a table, that table's row and column
  // controls.
  const bubbleItems = computed(() => [
    [
      { kind: 'mark', mark: 'bold', icon: 'i-lucide-bold', 'aria-label': 'Bold', tooltip: { text: 'Bold' } },
      { kind: 'mark', mark: 'italic', icon: 'i-lucide-italic', 'aria-label': 'Italic', tooltip: { text: 'Italic' } },
      { kind: 'mark', mark: 'strike', icon: 'i-lucide-strikethrough', 'aria-label': 'Strikethrough', tooltip: { text: 'Strikethrough' } },
      { kind: 'mark', mark: 'code', icon: 'i-lucide-code', 'aria-label': 'Inline code', tooltip: { text: 'Inline code' } },
      { kind: 'link', icon: 'i-lucide-link', 'aria-label': 'Link', tooltip: { text: 'Link' } },
      { kind: 'docLink', icon: 'i-lucide-file-symlink', 'aria-label': 'Link to page', tooltip: { text: 'Link to a page' } },
    ],
    [
      { kind: 'heading', level: 2, icon: 'i-lucide-heading-2', 'aria-label': 'Heading 2', tooltip: { text: 'Heading 2' } },
    ],
    ...(caretInTable.value ? [tableBubbleItems] : []),
    [
      {
        icon: 'i-lucide-message-square-plus',
        'aria-label': 'Comment',
        tooltip: { text: 'Comment on the selection' },
        onClick: () => commentOnSelection(),
      },
    ],
  ])

  return {
    page: page as Ref<Page>,
    provider,
    liveStatus,
    peers,
    presence,
    synced,
    deletedRemotely,
    commitStatus,
    commitError,
    lastSavedAt,
    savedAgo,
    externalChange,
    entityFields,
    fieldsSeeded,
    entityField,
    setEntityField,
    fieldPeers,
    focusEntityField,
    frontmatter,
    editorRef,
    blockMeta,
    reviewer,
    me,
    goToBlock,
    extensions,
    slashItems,
    comarkHandlers,
    historyItems,
    blockMenu,
    hoveredBlock,
    openBlockMenu,
    openBlockMenuAtCursor,
    closeBlockMenu,
    onBlockMenuCloseAutoFocus,
    selectBlockAt,
    toolbarItems,
    toolbarExtendedItems,
    toolbarOverflowItems,
    toolbarTrailingItems,
    bubbleItems,
    mentionQuery,
    mentionItems,
    docItems,
    searchDocs,
    docLabel,
    markdown,
    save,
    revert,
    reload,
    attachFile,
    approveItem,
    markSelectedBlockReviewed,
    threads,
    commentDraft,
    commentOnSelection,
    threadsShownFor,
    postComment,
    replyToComment,
    setCommentResolved,
    setCommentAssignee,
  }
}
