import type {
  DataUIPart,
  ReasoningUIPart,
  TextUIPart,
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
        : 'Answered, but not from your knowledge base.'
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
