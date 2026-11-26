import { describe, it, expect } from 'vitest'
import type { UIMessage, UIMessagePart } from 'ai'
import { announce, answerTextFor, citationsFor, searchesFor, shownCitationsFor, SEARCH_TOOL, sourceRowsFor, toolRunsFor, toolRunsLabel, UNGROUNDED_EXPLANATION } from './chat-answer'
import type { GroundingState, ToolRun } from './chat-answer'

function grounding(state: GroundingState, retrieved?: number) {
  return { mode: 'grounded', state, retrieved }
}

/** An assistant turn made of the parts the bridge streamed for it. */
function turn(...parts: unknown[]): UIMessage {
  return { id: 'm-1', role: 'assistant', parts: parts as UIMessagePart[] } as UIMessage
}

/** One finished call, as the bridge's `dynamic` tool parts reduce to. */
function call(name: string, over: Record<string, unknown> = {}) {
  return {
    type: 'dynamic-tool',
    toolName: name,
    toolCallId: `c-${name}`,
    state: 'output-available',
    input: { q: 'spaces' },
    output: { spaces: ['ops'] },
    resultProviderMetadata: { vercel_ai_sdk: { durationMs: 12 } },
    ...over,
  }
}

/** The same call as failed, with the tool's own sentence on it. */
function failedCall(name: string, errorText: string) {
  return call(name, { state: 'output-error', output: undefined, errorText })
}

describe('announce', () => {
  it('says how many sources a grounded answer stands on', () => {
    expect(announce(grounding('grounded'), 2)).toBe('Answered from 2 sources.')
    expect(announce(grounding('grounded'), 1)).toBe('Answered from 1 source.')
  })

  it('names the state an answer without sources is in', () => {
    // The same sentence the badge's tooltip explains it with.
    expect(announce(grounding('ungrounded', 2), 0)).toContain(UNGROUNDED_EXPLANATION)
    expect(announce(grounding('ungrounded', 0), 0)).toContain('nothing in the pages you can read matched')
    expect(announce(grounding('insufficient_evidence'), 0)).toContain('Nothing in the pages you can read')
    expect(announce(grounding('dependency_unavailable'), 0)).toContain('Search is unavailable')
  })

  it('says a turn without a search, under retrieval off, found nothing only once the model searched', () => {
    const off = { mode: 'grounded', retrieval: 'off' as const, state: 'ungrounded' as const, retrieved: 0 }
    expect(announce(off, 0)).toContain(UNGROUNDED_EXPLANATION)
    expect(announce(off, 0, 1)).toContain('nothing in the pages you can read matched')
  })

  it('says nothing about an answer nothing grounded', () => {
    expect(announce(null, 0)).toBe('')
  })
})

describe('answerTextFor', () => {
  const text = { type: 'text', text: 'I found nothing on that.' }

  it('shows no text in the outage state', () => {
    expect(answerTextFor(turn(text, { type: 'data-grounding', data: grounding('dependency_unavailable') }))).toBe('')
  })

  it('shows the text in every other state, and while the answer streams', () => {
    expect(answerTextFor(turn(text, { type: 'data-grounding', data: grounding('insufficient_evidence') }))).toBe(text.text)
    expect(answerTextFor(turn({ type: 'data-grounding', data: { mode: 'grounded', retrieved: 1 } }, text))).toBe(text.text)
    expect(answerTextFor(turn(text))).toBe(text.text)
  })
})

describe('toolRunsFor', () => {
  it('keeps every call of the turn, in the order it was made', () => {
    const runs = toolRunsFor(turn(
      { type: 'step-start' },
      call('tool__openkb_list_spaces'),
      { type: 'text', text: 'Ops and Docs.' },
      call('tool__openkb_search_pages'),
    ))

    expect(runs.map(r => r.name))
      .toEqual(['tool__openkb_list_spaces', 'tool__openkb_search_pages'])
    expect(runs[0]).toMatchObject({
      toolCallId: 'c-tool__openkb_list_spaces',
      input: { q: 'spaces' },
      output: { spaces: ['ops'] },
      failed: false,
      running: false,
      ms: 12,
    })
  })

  it('puts a tool failure on the tool, with what the tool said', () => {
    const [run] = toolRunsFor(turn(failedCall('tool__nope', 'No tool named "tool__nope" is available to you.')))

    expect(run).toMatchObject({
      failed: true,
      running: false,
      errorText: 'No tool named "tool__nope" is available to you.',
    })
    expect(run!.output).toBeUndefined()
  })

  it('marks a call that has been asked for and has not answered', () => {
    const [run] = toolRunsFor(turn(call('tool__slow', { state: 'input-available', output: undefined, resultProviderMetadata: undefined })))

    expect(run).toMatchObject({ failed: false, running: true, ms: undefined })
  })

  it('reads the name off the part type when the call is not marked dynamic', () => {
    const runs = toolRunsFor(turn({
      type: 'tool-tool__openkb_get_page',
      toolCallId: 'c-1',
      state: 'output-available',
      input: {},
      output: {},
    }))

    expect(runs.map(r => r.name)).toEqual(['tool__openkb_get_page'])
  })

  it('finds no calls in a turn that made none', () => {
    expect(toolRunsFor(turn({ type: 'text', text: 'Hello.' }))).toEqual([])
  })
})

describe('toolRunsLabel', () => {
  const runs = (...failed: boolean[]): ToolRun[] =>
    failed.map((f, i) => ({ toolCallId: `c-${i}`, name: 't', input: {}, failed: f, running: false }))

  it('counts the calls a turn made', () => {
    expect(toolRunsLabel(runs(false))).toBe('1 tool call')
    expect(toolRunsLabel(runs(false, false))).toBe('2 tool calls')
  })

  it('says so when every call failed', () => {
    expect(toolRunsLabel(runs(true))).toBe('1 tool call failed')
    expect(toolRunsLabel(runs(true, true))).toBe('2 tool calls failed')
  })

  it('counts the failures apart when only some failed', () => {
    expect(toolRunsLabel(runs(true, false))).toBe('2 tool calls, 1 failed')
  })

  it('says nothing about a turn that called nothing', () => {
    expect(toolRunsLabel([])).toBe('')
  })
})

describe('citationsFor', () => {
  it('reads the cited sources off the source parts, with their numbers', () => {
    const cited = citationsFor(turn(
      { type: 'text', text: 'Tag it [2].' },
      {
        type: 'source-url',
        sourceId: '/ops/release#b-2',
        url: '/ops/release#b-2',
        title: 'Release',
        providerMetadata: { ai_rag_cite: { n: 2, meta: 'Release › Tagging', score: 0.81 } },
      },
      { type: 'source-url', sourceId: '/ops/read', url: '/ops/read', title: 'Read', providerMetadata: { ai_rag_cite: { n: 3, meta: '', score: 0 } } },
    ))

    expect(cited).toEqual([
      { n: 2, sourceId: '/ops/release#b-2', path: '/ops/release#b-2', title: 'Release', meta: 'Release › Tagging', score: 0.81 },
      { n: 3, sourceId: '/ops/read', path: '/ops/read', title: 'Read', meta: '', score: 0 },
    ])
  })

  it('leaves out a source part that carries no number', () => {
    expect(citationsFor(turn({ type: 'source-url', sourceId: 'x', url: 'https://example.com' }))).toEqual([])
  })
})

/** A source part numbered `n` by the citation pass, identified by its url. */
function source(n: number, url: string) {
  return { type: 'source-url', sourceId: url, url, title: `S${n}`, providerMetadata: { ai_rag_cite: { n, meta: '', score: 0 } } }
}

/** A search hit on block `b-a` of node 36, as `search_pages` names it. */
const HIT = (n: number) => source(n, '/node/36#b-a')

/** A page read of node 36, as `get_page` names it. */
const READ = (n: number) => source(n, '/node/36')

/** A retrieved passage of block `b-a` of node 36, as the chunk retriever names it. */
const RETRIEVED = (n: number) => source(n, '/node/36#b-a')

describe('shownCitationsFor', () => {
  /** What the reader sees per shown citation: its number, marker part and link. */
  function shown(text: string, ...sources: unknown[]) {
    return shownCitationsFor(turn({ type: 'text', text }, ...sources)).map(c => [c.n, c.cite, c.path])
  }

  it('gives each cited block of one page a number of its own', () => {
    expect(shown('Pumps [6#b-a], valves [6#b-b], seals [6#b-c].', source(6, '/node/36'))).toEqual([
      [1, '6#b-a', '/node/36#b-a'],
      [2, '6#b-b', '/node/36#b-b'],
      [3, '6#b-c', '/node/36#b-c'],
    ])
  })

  it('gives two citations of one block one number', () => {
    expect(shown('Pumps [6#b-a], again [6#b-a], the page [6].', source(6, '/node/36'))).toEqual([
      [1, '6#b-a', '/node/36#b-a'],
      [2, '6', '/node/36'],
    ])
  })

  it('numbers plain and block citations in the order the answer writes them', () => {
    expect(shown('First [3], then [1, 3#b-x].', source(1, '/a#b-lead'), source(3, '/node/3'))).toEqual([
      [1, '3', '/node/3'],
      [2, '1', '/a#b-lead'],
      [3, '3#b-x', '/node/3#b-x'],
    ])
  })

  it('leaves out a marker no source stands behind', () => {
    expect(shown('Only [2#b-x] and [1].', source(1, '/a'))).toEqual([[1, '1', '/a']])
  })

  it('gives a search hit and a page read of one block one number', () => {
    expect(shown('Hit [2], read [5#b-a], the page [5].', HIT(2), READ(5))).toEqual([
      [1, '2', '/node/36#b-a'],
      [1, '5#b-a', '/node/36#b-a'],
      [2, '5', '/node/36'],
    ])
  })

  it('numbers no marker written in code', () => {
    expect(shown('Write `[1]` as\n\n```\n[2]\n```\n\nsee [2].', source(1, '/a'), source(2, '/b'))).toEqual([[1, '2', '/b']])
  })

  it('numbers the markers of an answer whose fence is still open', () => {
    expect(shown('See [1].\n\n~~~\n[2]', source(1, '/a'), source(2, '/b'))).toEqual([[1, '1', '/a']])
  })

  it('numbers no source without a path', () => {
    expect(shown('Pathless [2], then [1].', source(1, '/a'), source(2, ''))).toEqual([[1, '1', '/a']])
  })
})

describe('sourceRowsFor', () => {
  it('gives a retrieved passage and a page read of one block one number and one row', () => {
    const rows = sourceRowsFor(turn(
      { type: 'text', text: 'Retrieved [1], read [4#b-a].' },
      RETRIEVED(1),
      READ(4),
    ))
    expect(rows.map(c => [c.n, c.path])).toEqual([[1, '/node/36#b-a']])
  })

  it('lists one row per shown number', () => {
    const rows = sourceRowsFor(turn(
      { type: 'text', text: 'Hit [2], read [5#b-a], more [5#b-b].' },
      HIT(2),
      READ(5),
    ))
    expect(rows.map(c => [c.n, c.path])).toEqual([[1, '/node/36#b-a'], [2, '/node/36#b-b']])
  })
})

describe('searchesFor', () => {
  it('reads each search off its tool call, running or answered', () => {
    const searches = searchesFor(turn(
      call(SEARCH_TOOL, { toolCallId: 'c-1', input: { terms: 'XK-4471B', question: 'Who maintains the coolant pump XK-4471B?' }, output: { success: true, message: '3 result(s)', outputs: { total: 3 } } }),
      call('tool__openkb_get_page', { input: { path: '/ops/pump' } }),
      call(SEARCH_TOOL, { toolCallId: 'c-2', state: 'input-available', input: { q: 'pump maintenance' }, output: undefined }),
    ))

    expect(searches).toEqual([
      { toolCallId: 'c-1', query: { terms: 'XK-4471B', question: 'Who maintains the coolant pump XK-4471B?' }, running: false, hits: 3 },
      { toolCallId: 'c-2', query: { terms: '', question: 'pump maintenance' }, running: true, hits: undefined },
    ])
  })

  it('does not count a listing, which searches for nothing', () => {
    expect(searchesFor(turn(call(SEARCH_TOOL, { input: { space: 'ops' } })))).toEqual([])
  })
})
