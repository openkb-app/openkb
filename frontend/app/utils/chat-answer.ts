import type {
  DataUIPart,
  DynamicToolUIPart,
  ReasoningUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from 'ai'
import { citedParts } from '#shared/utils/comark-tree'

/** One source an answer cited, read off its `source-url` part. */
export interface Citation {
  /** The `[n]` the answer cites it by. */
  n: number
  /** Names the source the same way on every read. */
  sourceId: string
  path: string
  title: string
  /** One line placing the source; '' where it has none. */
  meta: string
  /** How well it matched the search up front; 0 for a source a tool read. */
  score: number
}

/** One cited block of a source, with the number the reader sees on it. */
export interface ShownCitation extends Citation {
  /** The marker part it stands for: `4`, or `4#b-1a2b` for a block of source 4. */
  cite: string
}

/**
 * The provider-metadata namespace a source part carries its number under.
 *
 * The protocol's source part has no field for the `[n]` an answer cites it
 * by, so `ai_rag_cite` puts it, the source's place and its score there.
 */
const CITATION_METADATA = 'ai_rag_cite'

/**
 * How an answer stands to the sources it was allowed to be built from.
 *
 * - `grounded` — it cited what it used.
 * - `ungrounded` — it cited nothing; `retrieved` says whether there was
 *   anything to cite. Only the `grounded` mode reaches it.
 * - `insufficient_evidence` — nothing cleared the gate; no model ran. Only
 *   the `strict` mode reaches it.
 * - `dependency_unavailable` — retrieval could not be reached at all.
 */
export type GroundingState =
  | 'grounded'
  | 'ungrounded'
  | 'insufficient_evidence'
  | 'dependency_unavailable'

/**
 * What an answer that cited nothing is badged with, and the sentence behind it.
 *
 * One pair, read by the badge, its tooltip and the spoken announcement, so the
 * wording is picked once.
 */
export const UNGROUNDED_LABEL = 'From AI knowledge'
export const UNGROUNDED_EXPLANATION
  = 'This answer comes from the AI model\'s general knowledge, not from any page in your knowledge base.'

/** What a turn searched for, as its query step wrote it. */
export interface SearchQuery {
  /** The exact words a section had to hold; '' when it named none. */
  terms: string
  /** The question matched by meaning. */
  question: string
}

export interface Grounding {
  mode: string
  /**
   * `always`: searched before the model ran. `off`: the model searched with
   * its tools, or not at all.
   */
  retrieval?: 'always' | 'off'
  /** Absent while the answer streams: what it cited is not known yet. */
  state?: GroundingState
  /** How many sources the answer was offered. */
  retrieved?: number
  /** What was searched for; absent when the turn searched nothing. */
  query?: SearchQuery
}

function isText(p: UIMessagePart): p is TextUIPart {
  return p.type === 'text'
}

export function isReasoning(p: UIMessagePart): p is ReasoningUIPart {
  return p.type === 'reasoning'
}

export function textFor(m: UIMessage): string {
  return m.parts.filter(isText).map(p => p.text).join('')
}

/**
 * The text an assistant answer shows: none in the outage state.
 *
 * The outage state says what happened; the no-answer text sent with it would
 * say nothing was found.
 */
export function answerTextFor(m: UIMessage): string {
  return groundingFor(m)?.state === 'dependency_unavailable' ? '' : textFor(m)
}

/**
 * Whether a message part is a `source-url` part.
 */
function isSourceUrl(p: UIMessagePart): p is SourceUrlUIPart {
  return p.type === 'source-url'
}

/**
 * The sources the answer cited, empty when it cited none.
 *
 * A source part without a number is not one the answer can have cited.
 */
export function citationsFor(m: UIMessage): Citation[] {
  return m.parts.filter(isSourceUrl).flatMap((part) => {
    const cited = part.providerMetadata?.[CITATION_METADATA]
    if (typeof cited?.n !== 'number') return []
    return [{
      n: cited.n,
      sourceId: part.sourceId,
      path: part.url,
      title: part.title ?? '',
      meta: typeof cited.meta === 'string' ? cited.meta : '',
      score: typeof cited.score === 'number' ? cited.score : 0,
    }]
  })
}

/**
 * What the answer cites, one entry per marker part, numbered as the reader
 * sees it.
 *
 * Numbered by where the citation leads, in the order the answer writes them,
 * as the read view numbers stored citations (`citeNode` in
 * #shared/utils/comark-tree.ts):
 * - Two blocks of one page are two numbers.
 * - Two citations of one block are one number, also a search hit `[2]` and a
 *   page read `[5#b-a]` of that block.
 * - `[4#b-1a2b]` leads to that block of source 4's page.
 * - A source with no path is no link: it gets no number, as its marker gets
 *   no chip.
 */
export function shownCitationsFor(m: UIMessage): ShownCitation[] {
  const sources = citationsFor(m)
  const numbers = new Map<string, number>()
  const shown = new Map<string, ShownCitation>()
  for (const cite of citedParts(answerTextFor(m))) {
    if (shown.has(cite)) continue
    const [n, block] = cite.split('#')
    const source = sources.find(c => String(c.n) === n)
    if (!source?.path) continue
    const path = block ? `${source.path.split('#')[0]}#${block}` : source.path
    const number = numbers.get(path) ?? numbers.size + 1
    numbers.set(path, number)
    shown.set(cite, { ...source, n: number, cite, path })
  }
  return [...shown.values()]
}

/**
 * The Sources rows: one per shown number.
 *
 * Two marker parts leading to one block share a number, so they share a row.
 */
export function sourceRowsFor(m: UIMessage): ShownCitation[] {
  const rows = new Map<number, ShownCitation>()
  for (const cite of shownCitationsFor(m)) {
    if (!rows.has(cite.n)) rows.set(cite.n, cite)
  }
  return [...rows.values()]
}

/**
 * How the answer stands, or null when nothing grounded it.
 *
 * An assistant without grounding configured streams no such part, and the
 * surfaces then render exactly what they rendered before it existed.
 */
export function groundingFor(m: UIMessage): Grounding | null {
  return dataFor<Grounding>(m, 'data-grounding') ?? null
}

/**
 * Whether an uncited answer stands on a search that found nothing.
 *
 * With retrieval off nothing is searched unless the model searches, so an
 * answer to a turn without a search found nothing only in that it looked
 * for nothing.
 *
 * @param searches How many searches the model ran on the turn.
 */
export function searchFoundNothing(grounding: Grounding | null, searches: number): boolean {
  if (grounding?.state !== 'ungrounded' || grounding.retrieved !== 0) return false
  return grounding.retrieval !== 'off' || searches > 0
}

/**
 * How the finished answer stands, in one sentence for a live region.
 *
 * Terse on purpose: it is heard, not read, and the same states are on screen
 * in full next to the answer.
 */
export function announce(grounding: Grounding | null, cited: number, searches = 0): string {
  switch (grounding?.state) {
    case 'grounded':
      return `Answered from ${cited} source${cited === 1 ? '' : 's'}.`
    case 'ungrounded':
      return searchFoundNothing(grounding, searches)
        ? 'Answered, but nothing in the pages you can read matched.'
        : `Answered. ${UNGROUNDED_EXPLANATION}`
    case 'insufficient_evidence':
      return 'Nothing in the pages you can read answers that.'
    case 'dependency_unavailable':
      return 'Search is unavailable, so there was nothing to answer from.'
    default:
      return ''
  }
}

/** The payload of one data part, as the bridge writes it. */
function dataFor<T>(m: UIMessage, type: string): T | undefined {
  const part = m.parts.find(p => p.type === type) as DataUIPart<T> | undefined
  return part?.data as T | undefined
}

/** One tool the assistant called on a turn, as the bridge streams it. */
export interface ToolRun {
  toolCallId: string
  /** The site's own function name, such as `tool__openkb_list_spaces`. */
  name: string
  /** What it was called with. */
  input: unknown
  /** What came back, while the call succeeded. */
  output?: unknown
  /** What the tool said instead, while it failed. */
  errorText?: string
  failed: boolean
  /** It has been asked for and has not answered yet. */
  running: boolean
  /** How long it took, in milliseconds, once it is over. */
  ms?: number
}

/**
 * The provider-metadata namespace the bridge writes a call's timing under.
 *
 * A result part's provider metadata is the one field of it the AI SDK carries
 * through to the message, so it is where the duration rides.
 */
const BRIDGE_METADATA = 'vercel_ai_sdk'

type AnyToolUIPart = ToolUIPart | DynamicToolUIPart

function isToolPart(p: UIMessagePart): p is AnyToolUIPart {
  return p.type === 'dynamic-tool' || (typeof p.type === 'string' && p.type.startsWith('tool-'))
}

/**
 * The tools the assistant called, in the order it called them.
 *
 * The bridge marks every call dynamic, because the site decides which tools
 * exist and the client holds no schema for them; a part that arrives without
 * that mark carries its name in its own type instead.
 */
export function toolRunsFor(m: UIMessage): ToolRun[] {
  return m.parts.filter(isToolPart).map((p) => {
    const part = p as AnyToolUIPart & {
      input?: unknown
      output?: unknown
      errorText?: string
      resultProviderMetadata?: Record<string, Record<string, unknown>>
    }
    const ms = part.resultProviderMetadata?.[BRIDGE_METADATA]?.durationMs
    return {
      toolCallId: part.toolCallId,
      name: part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length),
      input: part.input,
      output: part.state === 'output-available' ? part.output : undefined,
      errorText: part.state === 'output-error' ? part.errorText : undefined,
      failed: part.state === 'output-error',
      running: part.state === 'input-streaming' || part.state === 'input-available',
      ms: typeof ms === 'number' ? ms : undefined,
    }
  })
}

/**
 * What the collapsed row says: how many calls, and how many did not work.
 *
 * Empty for a turn that called nothing, which is the turn that shows no row.
 */
export function toolRunsLabel(runs: ToolRun[]): string {
  if (!runs.length) return ''
  const calls = `${runs.length} tool call${runs.length === 1 ? '' : 's'}`
  const failed = runs.filter(r => r.failed).length
  if (!failed) return calls
  return failed === runs.length ? `${calls} failed` : `${calls}, ${failed} failed`
}

/**
 * The function name the chat calls the search tool by.
 *
 * `tool_ai_connector` names a Tool API tool `tool__<plugin id>`.
 */
export const SEARCH_TOOL = 'tool__openkb_search_pages'

/** One search the assistant ran on a turn, as its tool call streams it. */
export interface ToolSearch {
  toolCallId: string
  /** What it searched for: a plain `q` reads as the question. */
  query: SearchQuery
  /** It has been asked for and has not answered yet. */
  running: boolean
  /** How many hits it answered, once it has; absent while it runs or failed. */
  hits?: number
}

/** A string argument of a tool call, '' where it is missing. */
function stringArgument(input: unknown, name: string): string {
  const value = (input as Record<string, unknown> | null)?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The searches the assistant ran, in the order it ran them.
 *
 * A listing call, which asks nothing, is not a search.
 */
export function searchesFor(m: UIMessage): ToolSearch[] {
  return toolRunsFor(m)
    .filter(run => run.name === SEARCH_TOOL)
    .flatMap((run) => {
      const q = stringArgument(run.input, 'q')
      const query = {
        terms: q ? '' : stringArgument(run.input, 'terms'),
        question: q || stringArgument(run.input, 'question'),
      }
      if (!query.terms && !query.question) return []
      // A Tool API result carries the tool's outputs under `outputs`.
      const total = (run.output as { outputs?: { total?: unknown } } | undefined)?.outputs?.total
      return [{
        toolCallId: run.toolCallId,
        query,
        running: run.running,
        hits: typeof total === 'number' ? total : undefined,
      }]
    })
}
