/**
 * The Pele options every surface passes, so a diagram links the same on the
 * server and in the browser. No Pele import here: `fence.ts` and the editor
 * read nothing that loads the renderer.
 */
export const PELE_OPTIONS = {
  /** Source cap, below Pele's own 50,000. */
  limit: 16_384,
  linkSchemes: ['http', 'https'],
  imageSchemes: ['http', 'https'],
}
