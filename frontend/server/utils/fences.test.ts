import { describe, it, expect } from 'vitest'
import { fenceErrors, renderFence } from './fences'
import { fenceFor } from '#shared/utils/fences'

const stub = fenceFor('stub')!

describe('renderFence', () => {
  it("renders through the fence's server.ts", async () => {
    expect(await renderFence(stub, 'a < b', 'f-1-')).toEqual({ html: '<svg id="f-1-stub"><text>a &lt; b</text></svg>' })
  })

  it("answers the server.ts's error", async () => {
    expect(await renderFence(stub, 'one\ntw!o', 'f-1-')).toEqual({ error: { message: 'Unexpected "!"', line: 2, column: 3 } })
  })

  it('renders nothing for a fence without one', async () => {
    expect(await renderFence({ ...stub, language: 'none' }, 'x', 'f-1-')).toEqual({})
  })
})

describe('fenceErrors', () => {
  it('passes markdown whose fences check, and markdown with none', async () => {
    expect(await fenceErrors('::block{#b-1}\n```stub\none\n```\n::')).toEqual([])
    expect(await fenceErrors('A stub! Not a fence.')).toEqual([])
  })

  it('names the line and column of each fence that does not, numbered at any depth', async () => {
    const markdown = '```stub\none\n```\n\n::callout\n```stub\none\ntw!o\n```\n::'
    expect(await fenceErrors(markdown)).toEqual(['Sketch 2 (Stub): Line 2, column 3: Unexpected "!"'])
  })

  it('checks a fence whatever the case of its info string', async () => {
    expect(await fenceErrors('```STUB\n!\n```')).toEqual(['Sketch (Stub): Line 1, column 1: Unexpected "!"'])
  })
})
