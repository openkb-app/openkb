import { describe, it, expect } from 'vitest'
import { recordLinkSelection, takeLinkSelection } from './doc-link-selection'

/**
 * The link-wrapping rule (OKB-250): the words a `[[` is about become the
 * link's label, and only for the `[[` that was opened on them.
 */
describe('the words a document link wraps', () => {
  it('gives them back to the pick at the position the `[[` landed at', () => {
    recordLinkSelection('the escalation path', 12)
    expect(takeLinkSelection(12)).toEqual({ text: 'the escalation path', range: null })
  })

  it('gives back where they still sit, for a `[[` opened after them', () => {
    recordLinkSelection('the escalation path', 31, { from: 12, to: 31 })
    expect(takeLinkSelection(31)).toEqual({
      text: 'the escalation path',
      range: { from: 12, to: 31 },
    })
  })

  it('reads once, so a second pick falls back to the target title', () => {
    recordLinkSelection('the escalation path', 12)
    takeLinkSelection(12)
    expect(takeLinkSelection(12)).toBeNull()
  })

  it('drops a record an abandoned `[[` left elsewhere in the document', () => {
    recordLinkSelection('the escalation path', 12)
    expect(takeLinkSelection(40)).toBeNull()
  })

  it('has nothing to wrap when the selection was only whitespace', () => {
    recordLinkSelection('  \n ', 12)
    expect(takeLinkSelection(12)).toBeNull()
  })
})
