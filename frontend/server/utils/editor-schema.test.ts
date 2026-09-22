import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { editorSchema, buildUEditorBaseExtensions } from './editor-schema'
import { buildEditorExtensions } from '../../app/editor/extensions'

/**
 * Drift tripwire for the commit schema. The headless commit path must
 * serialize against the SAME ProseMirror schema the browser editor uses, or
 * output diverges (and nodes the server does not know throw in Node.fromJSON).
 *
 * The structural assertion below is the one that matters: it diffs the server
 * schema against the schema the live editor's own extension list produces, so
 * adding a schema-contributing extension on one side only fails here without
 * anyone maintaining a list. The literal sets stay as a second, independent
 * check — they catch the case where BOTH sides change together because of a
 * Nuxt UI upgrade that alters what UEditor registers.
 *
 * buildEditorExtensions() only adds Vue NodeViews on top of the shared node
 * modules, and UEditor's own StarterKit/Code/HorizontalRule/Image/Mention set
 * is mirrored in editor-schema.ts — so the two schemas are expected to be
 * identical in node and mark names.
 */
const EXPECTED_NODES = [
  'doc', 'paragraph', 'text', 'heading', 'blockquote', 'codeBlock',
  'bulletList', 'orderedList', 'listItem', 'hardBreak', 'horizontalRule',
  'image', 'mention', 'docLink', 'citation', 'callout', 'infobox', 'blockWrapper',
  'table', 'tableRow', 'tableHeader', 'tableCell', 'taskList', 'taskItem',
].sort()

const EXPECTED_MARKS = ['bold', 'italic', 'strike', 'code', 'underline', 'link'].sort()

/**
 * The schema the browser editor actually runs on: what UEditor registers plus
 * the comark extension list from app/editor/extensions.ts.
 */
const clientSchema = getSchema([
  ...buildUEditorBaseExtensions(),
  ...buildEditorExtensions(),
])

describe('editorSchema (commit parity)', () => {
  it('carries every node the live editor extension list contributes', () => {
    const missing = Object.keys(clientSchema.nodes)
      .filter(name => !(name in editorSchema.nodes))
    expect(missing).toEqual([])
  })

  it('carries every mark the live editor extension list contributes', () => {
    const missing = Object.keys(clientSchema.marks)
      .filter(name => !(name in editorSchema.marks))
    expect(missing).toEqual([])
  })

  it('registers exactly the editor node set', () => {
    expect(Object.keys(editorSchema.nodes).sort()).toEqual(EXPECTED_NODES)
  })

  it('registers exactly the editor mark set', () => {
    expect(Object.keys(editorSchema.marks).sort()).toEqual(EXPECTED_MARKS)
  })

  it('reuses the shared Callout/Infobox fence attributes (no hand-copied schema)', () => {
    expect(editorSchema.nodes.callout!.spec.attrs).toHaveProperty('type')
    expect(editorSchema.nodes.infobox!.spec.attrs).toHaveProperty('title')
  })
})
