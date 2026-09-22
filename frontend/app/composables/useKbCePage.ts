import type { InjectionKey, Ref } from 'vue'
import { flattenDrupalMessages, type DrupalMessage, type DrupalMessages } from '#shared/utils/drupal-messages'

/** A local task as the CE-API response carries it — Drupal's access answer. */
interface LocalTask {
  label?: string
  url?: string
}

/** A CE page response, as the catch-all fetched it. */
export interface KbCePage {
  title?: string
  content?: unknown
  local_tasks?: { primary?: LocalTask[] }
  messages?: DrupalMessages
  key?: unknown
}

interface KbCePageEnvelope {
  /** The fetched page, reseated in place by `refresh`. */
  page: Ref<KbCePage>
  /**
   * Re-fetch the CE page and reseat it — the post-edit read refresh. Only the
   * catch-all that fetched the page can do this: a CE component receives its
   * element's props and slots, not the page wrapper the body slot is bound to.
   */
  refresh: () => Promise<void>
}

const KB_CE_PAGE: InjectionKey<KbCePageEnvelope> = Symbol('kb-ce-page')

/** The catch-all shares its fetched page + reseat with the CE component tree. */
export function provideKbCePage(page: Ref<KbCePage>, refresh: () => Promise<void>): void {
  provide(KB_CE_PAGE, { page, refresh })
}

/**
 * The page envelope, for a CE component that needs more than its own props: the
 * page it rides in, the reseat only the fetch owner can do, and the session's
 * local tasks — each one Drupal's access answer for that operation (an Edit tab
 * is node-update access, the same signal the collab server authorizes with).
 * The gates only shape the UI; enforcement stays server-side.
 *
 * Any editable node type reads these the same way; a payload without a dedicated
 * component simply never injects it.
 */
export function useKbCePage() {
  const env = inject(KB_CE_PAGE)
  if (!env) throw new Error('useKbCePage() must be called inside the CE catch-all tree')
  const { page, refresh } = env

  const localTasks = computed<LocalTask[]>(() => {
    const tasks = page.value?.local_tasks?.primary ?? []
    return Array.isArray(tasks) ? tasks : []
  })
  const canEdit = computed(() => localTasks.value.some(t => t?.label === 'Edit'))
  // Delete is its own Drupal permission — with editorial moderation an editor
  // who may update a page is not necessarily allowed to remove it, so this
  // asks the payload for the Delete task rather than reusing canEdit.
  const canDelete = computed(() => localTasks.value.some(t => t?.label === 'Delete'))
  // The *Revisions* task, taken whole — Drupal ships it only to a session that
  // may follow it, so this asks the revision-access question directly instead
  // of standing in for it with edit access.
  const historyHref = computed(() => localTasks.value.find(t => t?.label === 'Revisions')?.url ?? null)
  const title = computed(() => page.value?.title ?? '')

  /**
   * Drupal's messages for this render. They ride the page payload rather than
   * the connector's message state, which is only ever filled on the client —
   * after a form POST the page is rendered on the server, and that is exactly
   * the render carrying the one-time secret of a created API client.
   */
  const messages = computed<DrupalMessage[]>(() => flattenDrupalMessages(page.value?.messages))

  return { page, refresh, localTasks, canEdit, canDelete, historyHref, title, messages }
}

export type KbCePageContext = ReturnType<typeof useKbCePage>
