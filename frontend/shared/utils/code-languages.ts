/**
 * The languages a code fence is highlighted in, and the info strings that
 * name them. No Shiki import: the editor's language picker and the tree pass
 * read this list without loading the highlighter.
 *
 * Every fence component's language is in the list too, highlighted where
 * Shiki has a grammar for it (shared/utils/code-highlight.ts).
 */
import { FENCES } from '#shared/utils/fences'

/** A language the highlighter loads, and the label the picker shows. */
export interface CodeLanguage {
  id: string
  label: string
  aliases: readonly string[]
}

const HIGHLIGHTED: readonly CodeLanguage[] = [
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'shellscript', 'zsh'] },
  { id: 'css', label: 'CSS', aliases: [] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'dockerfile', label: 'Dockerfile', aliases: ['docker'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'html', label: 'HTML', aliases: [] },
  { id: 'ini', label: 'INI', aliases: ['properties'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'mjs', 'cjs'] },
  { id: 'json', label: 'JSON', aliases: [] },
  { id: 'markdown', label: 'Markdown', aliases: ['md'] },
  { id: 'mermaid', label: 'Mermaid', aliases: [] },
  { id: 'php', label: 'PHP', aliases: [] },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'sql', label: 'SQL', aliases: [] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'mts', 'cts'] },
  { id: 'vue', label: 'Vue', aliases: [] },
  { id: 'xml', label: 'XML', aliases: ['svg'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
]

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  ...HIGHLIGHTED,
  ...FENCES
    .filter(fence => !HIGHLIGHTED.some(lang => lang.id === fence.language))
    .map(fence => ({ id: fence.language, label: fence.languageLabel, aliases: [] })),
].sort((a, b) => a.label.localeCompare(b.label))

const BY_NAME = new Map<string, CodeLanguage>(
  CODE_LANGUAGES.flatMap(lang => [lang.id, ...lang.aliases].map(name => [name, lang] as const)),
)

/**
 * The language a fence's info string names, or null for one outside the set.
 * Only the first word counts: `php {1}` is php.
 */
export function codeLanguage(info: string | null | undefined): CodeLanguage | null {
  const name = (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return BY_NAME.get(name) ?? null
}
