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
 * A re-mint renames the block in this payload only; the live document keeps the
 * duplicate, because a commit does not write to the session. Nothing has to
 * follow the rename: the id stays on the occurrence `keepers` names, which is
 * the session's own accounting answering for the block it indexed (see
 * {@link sharedIdKeepers} in server/utils/collab-attribution.ts). Every other
 * occurrence arrives as a block in review that the session witnessed nobody
 * writing — credited to whoever's write carried it, or to nobody at all on a
 * checkpoint. That is the right way round: the block keeping the id is the one
 * every comment and sign-off already points at, and a client that duplicates
 * an id reaches only the block it introduced, never the one it aimed at.
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
