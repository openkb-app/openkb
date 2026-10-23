import type { JSONContent } from '@tiptap/core'
import { dedupeBlockIds } from '#shared/page-blocks'
import type { CommitHooks, ProseMirrorJSON } from './commit'

/**
 * Block-id hygiene on the way into a commit.
 *
 * No two top-level blocks may reach Drupal sharing an id: the review sidecar,
 * the bylines and the comments are all keyed on it, and an aliased key silently
 * merges two blocks' histories. The editor's minter re-mints a split's
 * duplicate as it happens, but a client without it can still produce one, so
 * the commit checks rather than assumes.
 *
 * Only duplicates are touched. Minting for id-less blocks here would stamp ids
 * into content the session never edited — rewriting somebody else's paragraphs
 * as a side effect of saving your own.
 *
 * The checkpoint writes the same names into the live document before it
 * commits (`settleSharedIds` in server/plugins/hocuspocus.ts); this pass covers
 * a duplicate that lands in between. The id stays on
 * the occurrence `keepers` names, the block every comment, contributor and
 * sign-off already points at (see {@link sharedIdKeepers} in
 * server/utils/collab-attribution.ts). Every other occurrence goes out under
 * the id the session's accounting already indexes it by, so the writer who
 * made the copy is the one the window states for it.
 *
 * The answer is taken from the accounting rather than worked out again here.
 * Whichever occurrence keeps the id inherits the sidecar keyed on it, so an end
 * of this seam deriving its own answer is an end that can name a different
 * block from the one the contributors, the comments and the sign-offs describe.
 *
 * The sidecar itself does NOT ride this payload. `field_block_meta` is
 * write-dead to clients: Drupal writes every flag, contributor and sign-off in it
 * from what it witnessed, and strips the field from anything a caller sends
 * (\Drupal\openkb_collab_api\Controller\CommitResource). The live session's
 * copy is a mirror, re-read from Drupal after each checkpoint.
 */
export function blockIdCommitHooks(
  keepers?: ReadonlyMap<string, number>,
): Pick<CommitHooks, 'preSerialize'> {
  return {
    preSerialize: [(json: ProseMirrorJSON) =>
      dedupeBlockIds(json as JSONContent, keepers).json as ProseMirrorJSON],
  }
}
