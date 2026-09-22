import { describe, it, expect } from 'vitest'
// Read as source: the surface's setup awaits a live collab session.
import source from './PageInlineEditor.vue?raw'

describe('PageInlineEditor', () => {
  it('gives the bubble toolbar no update delay', () => {
    expect(source).toMatch(/<UEditorToolbar[^>]*:update-delay="0"/)
  })
})
