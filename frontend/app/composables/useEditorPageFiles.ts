import * as Y from 'yjs'
import { PAGE_FILE_KEYS, fileArray, hiddenFileMap, liveFileLists, liveHiddenFiles, removePageFile, setFileHidden, setFileName, type PageFileLists } from '#shared/utils/page-files'
import type { ResolvedFile } from '#shared/utils/files'
import type { Editor } from '@tiptap/core'
import type { PageFileChoice } from '~/editor/link-target'
import { removeFileFromPage, renamePageFile, setFileDescription, undoableFileChange } from '~/editor/page-file-insert'

/**
 * The editor's page file lists (ADR 0020), live from the session:
 * - `lists`, `resolved`, `settled`, `descriptions`, `hidden` and the edits,
 *   `remove`, `setHidden`, `rename` and `describe`, for the list below the
 *   editor;
 * - `attachments`: what the link bubble offers, and what a pasted download URL
 *   is matched against.
 */
export interface EditorPageFiles {
  lists: Ref<PageFileLists>
  /** The files, each under its name on this page. */
  resolved: Ref<Record<string, ResolvedFile>>
  /** Each file's own name, where this page shows another. */
  fileNames: Ref<Record<string, string>>
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
  /** Names a file on this page, as one undo step; an empty name shows the file's own. */
  rename: (uuid: string, name: string) => void
  /** The files with an `::attachment` card in the text: their description is editable. */
  carded: Ref<string[]>
  /** Sets the description of a file's `::attachment` cards, as one undo step. */
  describe: (uuid: string, description: string) => void
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
  const carded = ref<string[]>([])
  const readDescriptions = () => {
    const found: Record<string, string> = {}
    const cards = new Set<string>()
    for (const node of body.createTreeWalker(node => node instanceof Y.XmlElement && node.nodeName === 'attachment')) {
      const { file, description } = (node as Y.XmlElement).getAttributes()
      if (typeof file === 'string') cards.add(file)
      if (typeof file === 'string' && typeof description === 'string' && description) found[file] ??= description
    }
    descriptions.value = found
    carded.value = [...cards]
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

  const names = usePageFileNames(ydoc)
  const { resolved: own, settled } = useResolvedPageFiles(computed(() => PAGE_FILE_KEYS.flatMap(key => lists.value[key])))
  const resolved = computed(() => Object.fromEntries(Object.entries(own.value)
    .map(([uuid, file]) => [uuid, names.value[uuid] ? { ...file, name: names.value[uuid] } : file])))
  const fileNames = computed(() => Object.fromEntries(Object.keys(names.value).flatMap(uuid => own.value[uuid] ? [[uuid, own.value[uuid].name]] : [])))
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

  const rename = (uuid: string, name: string) => {
    const live = editor()
    const fileName = own.value[uuid]?.name ?? ''
    if (live && !live.isDestroyed) renamePageFile(live, uuid, name, resolved.value[uuid]?.name ?? fileName, fileName)
    else setFileName(ydoc, uuid, name.trim() === fileName ? '' : name)
  }

  const describe = (uuid: string, description: string) => {
    const live = editor()
    if (live && !live.isDestroyed) setFileDescription(live, uuid, description)
  }

  return { lists, resolved, fileNames, settled, descriptions, remove, hidden, setHidden, rename, carded, describe, attachments }
}
