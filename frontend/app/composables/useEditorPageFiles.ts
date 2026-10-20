import * as Y from 'yjs'
import { PAGE_FILE_KEYS, fileArray, liveFileLists, removePageFile, type PageFileLists } from '#shared/utils/page-files'
import type { PageFileKey, ResolvedFile } from '#shared/utils/files'
import type { Editor } from '@tiptap/core'
import type { PageFileChoice } from '~/editor/link-target'
import { removeFileFromPage } from '~/editor/page-file-insert'

/**
 * The editor's page file lists (ADR 0020), live from the session:
 * - `lists`, `resolved`, `settled`, `descriptions` and the one edit, `remove`,
 *   for the list below the editor;
 * - `attachments`: what the link bubble offers, and what a pasted download URL
 *   is matched against.
 */
export interface EditorPageFiles {
  lists: Ref<PageFileLists>
  resolved: Ref<Record<string, ResolvedFile>>
  /** False while unresolved files are still asked for. */
  settled: Ref<boolean>
  /** Each file's description: its first `::attachment` embed's, as on the read page. */
  descriptions: Ref<Record<string, string>>
  /** Takes a file off the page: out of its list and its embeds out of the text. */
  remove: (key: PageFileKey, uuid: string) => void
  attachments: Ref<PageFileChoice[]>
}

export function useEditorPageFiles(ydoc: Y.Doc, editor: () => Editor | undefined): EditorPageFiles {
  const arrays = PAGE_FILE_KEYS.map(key => fileArray(ydoc, key))
  const lists = ref<PageFileLists>(liveFileLists(ydoc))
  const read = () => { lists.value = liveFileLists(ydoc) }

  const body = ydoc.getXmlFragment('default')
  const descriptions = ref<Record<string, string>>({})
  const readDescriptions = () => {
    const found: Record<string, string> = {}
    for (const node of body.createTreeWalker(node => node instanceof Y.XmlElement && node.nodeName === 'attachment')) {
      const { file, description } = (node as Y.XmlElement).getAttributes()
      if (typeof file === 'string' && typeof description === 'string' && description) found[file] ??= description
    }
    descriptions.value = found
  }

  onMounted(() => {
    for (const array of arrays) array.observe(read)
    body.observeDeep(readDescriptions)
    read()
    readDescriptions()
  })
  onBeforeUnmount(() => {
    for (const array of arrays) array.unobserve(read)
    body.unobserveDeep(readDescriptions)
  })

  const { resolved, settled } = useResolvedPageFiles(computed(() => PAGE_FILE_KEYS.flatMap(key => lists.value[key])))
  const attachments = computed<PageFileChoice[]>(() => lists.value.attachments.flatMap((uuid) => {
    const file = resolved.value[uuid]
    return file ? [{ uuid, name: file.name, size: file.size, url: file.url }] : []
  }))

  const remove = (key: PageFileKey, uuid: string) => {
    const live = editor()
    if (live && !live.isDestroyed) removeFileFromPage(live, key, uuid, resolved.value[uuid]?.name)
    else removePageFile(ydoc, key, uuid)
  }

  return { lists, resolved, settled, descriptions, remove, attachments }
}
