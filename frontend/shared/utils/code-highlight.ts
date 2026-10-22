/**
 * Syntax highlighting for code fences, as token lines rather than HTML.
 *
 * - One Shiki highlighter per process, created on first use, with the
 *   JavaScript regex engine (no wasm).
 * - Languages load on demand from {@link CODE_LANGUAGES}, one chunk each.
 * - Both themes in one pass: a token carries `--shiki-light` and `--shiki-dark`
 *   and `main.css` picks one by colour mode, so switching needs no re-highlight.
 */
import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core'
import { CODE_LANGUAGES, codeLanguage } from './code-languages'

/** One run of text in one colour. `style` holds the theme variables; absent for plain text. */
export interface CodeToken {
  content: string
  style?: string
}

export type CodeLine = CodeToken[]

type LangModule = Promise<{ default: LanguageRegistration[] }>

/** Static import specifiers, so the bundler splits one chunk per language. */
const LOADERS: Record<string, () => LangModule> = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' }

/**
 * Theme colours replaced to hold 4.5:1 on the code background (`--ui-bg-muted`):
 * - the light comment colour;
 * - scopes the themes draw as text on a background, which is not rendered here.
 */
const COLOR_REPLACEMENTS = {
  'github-light-default': { '#6e7781': '#59636e', '#f6f8fa': '#1f2328', '#eaeef2': '#1f2328' },
  'github-dark-default': { '#161b22': '#e6edf3' },
}

/**
 * Tokenizer bounds, so one huge fence (e.g. minified JSON) cannot hold a
 * server render or an editor pass:
 * - a longer line stays plain;
 * - a longer fence stays plain as a whole.
 *
 * No time limit: a line cut off by time would colour differently on a busy host.
 */
const MAX_LINE_LENGTH = 1000
const MAX_CODE_LENGTH = 100_000

let highlighter: Promise<HighlighterCore> | null = null
/** The highlighter once created, for the synchronous {@link tokenize}. */
let ready: HighlighterCore | null = null
const loading = new Map<string, Promise<boolean>>()
const loaded = new Set<string>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    ready = await createHighlighterCore({
      themes: [import('shiki/themes/github-light-default.mjs'), import('shiki/themes/github-dark-default.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
    return ready
  })()
  return highlighter
}

/**
 * Loads the language an info string names, once. False for one outside the
 * set or one that failed to load: that fence stays plain.
 */
export function loadCodeLanguage(info: string | null | undefined): Promise<boolean> {
  const id = codeLanguage(info)?.id
  const loader = id ? LOADERS[id] : undefined
  if (!id || !loader) return Promise.resolve(false)
  let pending = loading.get(id)
  if (!pending) {
    pending = getHighlighter()
      .then(async (h) => {
        await h.loadLanguage((await loader()).default)
        loaded.add(id)
        return true
      })
      .catch(() => false)
    loading.set(id, pending)
  }
  return pending
}

/** Creates the highlighter and loads the given languages ahead of the first fence. */
export async function warmCodeHighlighter(ids: readonly string[] = CODE_LANGUAGES.map(l => l.id)): Promise<void> {
  await Promise.all(ids.map(loadCodeLanguage))
}

/** The code as plain lines, one token each. */
export function plainLines(code: string): CodeLine[] {
  return code.split('\n').map(line => (line === '' ? [] : [{ content: line }]))
}

/**
 * The fence's code as token lines, coloured for the language its info string
 * names. A language outside the set, or one that failed to load, is plain.
 */
export async function highlightToTokens(code: string, info: string | null | undefined): Promise<CodeLine[]> {
  await loadCodeLanguage(info)
  return tokenize(code, info) ?? plainLines(code)
}

/**
 * {@link highlightToTokens} without waiting: null while the language is not
 * loaded ({@link loadCodeLanguage}), plain lines for one outside the set, for
 * a fence past the bounds, or when tokenizing fails.
 */
export function tokenize(code: string, info: string | null | undefined): CodeLine[] | null {
  const lang = codeLanguage(info)
  if (!lang || code.length > MAX_CODE_LENGTH) return plainLines(code)
  if (!ready || !loaded.has(lang.id)) return null
  let tokens: ThemedToken[][]
  try {
    tokens = ready.codeToTokens(code, {
      lang: lang.id,
      themes: THEMES,
      defaultColor: false,
      colorReplacements: COLOR_REPLACEMENTS,
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
      tokenizeTimeLimit: 0,
    }).tokens
  }
  catch {
    return plainLines(code)
  }
  const plain = `--shiki-light:${ready.getTheme(THEMES.light).fg};--shiki-dark:${ready.getTheme(THEMES.dark).fg}`.toLowerCase()
  return tokens.map(line => mergeRuns(line.map((token) => {
    const style = styleString(token.htmlStyle ?? {})
    // Text in the themes' own foreground takes the page's text colour.
    return style === '' || style.toLowerCase() === plain ? { content: token.content } : { content: token.content, style }
  })))
}

/** The theme variables of one token. Backgrounds are left out: the block has its own. */
function styleString(style: Record<string, string>): string {
  return Object.entries(style)
    .filter(([key]) => !key.endsWith('-bg'))
    .map(([key, value]) => `${key}:${value}`)
    .join(';')
}

/** Adjacent tokens of one style as one, to keep the tree small. */
function mergeRuns(line: CodeLine): CodeLine {
  const out: CodeLine = []
  for (const token of line) {
    const last = out.at(-1)
    if (last && last.style === token.style) last.content += token.content
    else out.push({ ...token })
  }
  return out
}
