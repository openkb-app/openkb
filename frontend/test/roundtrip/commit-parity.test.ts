import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { Node as PMNode } from '@tiptap/pm/model'
import { loadCorpus } from './corpus'
import { productionImpl } from './harness'
import { editorSchema as commitSchema } from '../../server/utils/editor-schema'
import { serializeYDoc } from '../../server/utils/commit'

/**
 * Save-parity gate for the headless commit path over the round-trip corpus.
 *
 * The corpus proper (corpus.test.ts) exercises the CLIENT conversion — it says
 * nothing about the server-side commit schema. This suite takes each fixture
 * through the editor load path, then commits it the way the commit service
 * does (ProseMirror JSON → Y.Doc → commit schema → serializer) and asserts the
 * bytes match the client's own save. A node the commit schema does not carry
 * fails here in Node.fromJSON, per fixture that uses it.
 */
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('commit save-parity over the round-trip corpus', () => {
  for (const c of loadCorpus(fixturesDir)) {
    test(c.name, async () => {
      const doc = await productionImpl.load(c.input)
      const clientSave = productionImpl.save(doc)

      // The commit service only ever sees the JSON that synced into the Y.Doc.
      const ydoc = prosemirrorJSONToYDoc(commitSchema, doc.toJSON() as never, 'default')
      expect(serializeYDoc(ydoc), 'commit path must be byte-identical to the client save').toBe(clientSave)

      // Same JSON must also rebuild under the commit schema directly — the
      // check that throws on a node the server does not know.
      expect(() => PMNode.fromJSON(commitSchema, doc.toJSON() as never)).not.toThrow()
    })
  }
})
