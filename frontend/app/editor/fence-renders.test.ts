import { describe, it, expect } from 'vitest'
import { readFences } from './fence-renders'

describe('readFences', () => {
  it('collects every fence with a block id, nested ones too', () => {
    const fences = readFences([
      ['p', { id: 'b-par' }, 'text'],
      ['fence', { id: 'b-one', fence: 'mermaid', source: 'a', html: '<svg/>' }],
      ['ul', {}, ['li', {}, ['fence', { id: 'b-two', fence: 'mermaid', source: 'b', error: { message: 'x', line: 1, column: 1 } }]]],
      ['fence', { fence: 'mermaid', source: 'no id' }],
    ])
    expect([...fences.entries()]).toEqual([
      ['b-one', { source: 'a', html: '<svg/>', error: undefined }],
      ['b-two', { source: 'b', html: undefined, error: { message: 'x', line: 1, column: 1 } }],
    ])
  })
})
