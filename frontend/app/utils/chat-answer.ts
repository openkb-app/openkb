import type {
  DataUIPart,
  DynamicToolUIPart,
  ReasoningUIPart,
  TextUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from 'ai'

/** One source an answer cited, as `ai_rag_cite` publishes it. */
export interface Citation {
  n: number
  path: string
  title: string
  meta: string
  score: number
}

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

export interface Grounding {
  mode: string
  state: GroundingState
  /** How many sources the answer was offered. */
  retrieved?: number
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

/** The sources the answer cited, empty when it cited none. */
export function citationsFor(m: UIMessage): Citation[] {
  return dataFor<Citation[]>(m, 'data-citations') ?? []
}

/**
 * The cited sources a Sources list offers.
 *
 * A row is a link, so a source with no path is no better than an uncited
 * number — the same bar `chipsFor()` holds the markers to.
 */
export function linkedCitationsFor(m: UIMessage): Citation[] {
  return citationsFor(m).filter(c => c.path)
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
 * How the finished answer stands, in one sentence for a live region.
 *
 * Terse on purpose: it is heard, not read, and the same states are on screen
 * in full next to the answer.
 */
export function announce(grounding: Grounding | null, cited: number): string {
  switch (grounding?.state) {
    case 'grounded':
      return `Answered from ${cited} source${cited === 1 ? '' : 's'}.`
    case 'ungrounded':
      return grounding.retrieved === 0
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
