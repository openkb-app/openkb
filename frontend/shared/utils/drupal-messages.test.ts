import { describe, it, expect } from 'vitest'
import { flattenDrupalMessages } from './drupal-messages'

/**
 * Creating an API client answers with its secret exactly once, as a warning,
 * so the ordering is not cosmetic: the thing the reader has to act on before
 * leaving the page must not sit under a success note.
 */
describe('flattenDrupalMessages', () => {
  it('puts what went wrong first and what worked last', () => {
    expect(flattenDrupalMessages({
      success: ['API client created.'],
      warning: ['Copy the secret now.'],
      error: ['Something broke.'],
    })).toEqual([
      { kind: 'error', html: 'Something broke.' },
      { kind: 'warning', html: 'Copy the secret now.' },
      { kind: 'success', html: 'API client created.' },
    ])
  })

  it('answers nothing for a render that carried no messages', () => {
    expect(flattenDrupalMessages()).toEqual([])
    expect(flattenDrupalMessages({})).toEqual([])
  })
})
