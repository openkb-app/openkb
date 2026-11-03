import type * as Y from 'yjs'
import type { Ref } from 'vue'
import { PAGE_FILE_KEYS, fileArray, fileNameMap, liveFileNames } from '#shared/utils/page-files'

/** The session's file names on this page (`files.names`), live. Empty without a session. */
export function usePageFileNames(doc: Y.Doc | null): Ref<Record<string, string>> {
  const names = ref<Record<string, string>>(doc ? liveFileNames(doc) : {})
  if (!doc) return names
  const shared = [fileNameMap(doc), ...PAGE_FILE_KEYS.map(key => fileArray(doc, key))]
  const read = () => { names.value = liveFileNames(doc) }
  onMounted(() => {
    for (const type of shared) type.observe(read)
    read()
  })
  onBeforeUnmount(() => {
    for (const type of shared) type.unobserve(read)
  })
  return names
}
