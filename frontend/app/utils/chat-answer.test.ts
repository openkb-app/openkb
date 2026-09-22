import { describe, it, expect } from 'vitest'
import type { UIMessage, UIMessagePart } from 'ai'
import { announce, toolRunsFor, toolRunsLabel, UNGROUNDED_EXPLANATION } from './chat-answer'
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

  it('says nothing about an answer nothing grounded', () => {
    expect(announce(null, 0)).toBe('')
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
