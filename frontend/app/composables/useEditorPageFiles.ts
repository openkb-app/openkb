import * as Y from 'yjs'
import { PAGE_FILE_KEYS, fileArray, hiddenFileMap, liveFileLists, liveHiddenFiles, removePageFile, setFileHidden, type PageFileLists } from '#shared/utils/page-files'
import type { ResolvedFile } from '#shared/utils/files'
import type { Editor } from '@tiptap/core'
import type { PageFileChoice } from '~/editor/link-target'
import { removeFileFromPage, undoableFileChange } from '~/editor/page-file-insert'

/**
 * The editor's page file lists (ADR 0020), live from the session:
 * - `lists`, `resolved`, `settled`, `descriptions`, `hidden` and the edits,
 *   `remove` and `setHidden`, for the list below the editor;
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
  /** Takes a file off the page: out of every list that has it, its embeds out of the text. */
  remove: (uuid: string) => void
  /** The attachments hidden from the read page's list. */
  hidden: Ref<string[]>
  /** Hides an attachment from the read page's list or shows it, as one undo step. */
  setHidden: (uuid: string, hidden: boolean) => void
  attachments: Ref<PageFileChoice[]>
}

export function useEditorPageFiles(ydoc: Y.Doc, editor: () => Editor | undefined): EditorPageFiles {
  const arrays = PAGE_FILE_KEYS.map(key => fileArray(ydoc, key))
  const hiddenMap = hiddenFileMap(ydoc)
  const lists = ref<PageFileLists>(liveFileLists(ydoc))
  const hidden = ref<string[]>(liveHiddenFiles(ydoc))
  const read = () => {
    lists.value = liveFileLists(ydoc)
    hidden.value = liveHiddenFiles(ydoc)
  }

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
    hiddenMap.observe(read)
    body.observeDeep(readDescriptions)
    read()
    readDescriptions()
  })
  onBeforeUnmount(() => {
    for (const array of arrays) array.unobserve(read)
    hiddenMap.unobserve(read)
    body.unobserveDeep(readDescriptions)
  })

  const { resolved, settled } = useResolvedPageFiles(computed(() => PAGE_FILE_KEYS.flatMap(key => lists.value[key])))
  const attachments = computed<PageFileChoice[]>(() => lists.value.attachments.flatMap((uuid) => {
    const file = resolved.value[uuid]
    return file ? [{ uuid, name: file.name, size: file.size, url: file.url }] : []
  }))

  const remove = (uuid: string) => {
    const keys = PAGE_FILE_KEYS.filter(key => lists.value[key].includes(uuid))
    const live = editor()
    if (live && !live.isDestroyed) removeFileFromPage(live, keys, uuid, resolved.value[uuid]?.name)
    else for (const key of keys) removePageFile(ydoc, key, uuid)
  }

  const setHidden = (uuid: string, value: boolean) => {
    const live = editor()
    if (live && !live.isDestroyed) undoableFileChange(live, doc => setFileHidden(doc, uuid, value))
    else setFileHidden(ydoc, uuid, value)
  }

  return { lists, resolved, settled, descriptions, remove, hidden, setHidden, attachments }
}
