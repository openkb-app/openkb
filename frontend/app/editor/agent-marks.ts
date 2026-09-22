import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { addressableBlocks } from './review-marks'
import { claimLabel, type PresencePeer } from '#shared/utils/presence'

/**
 * "Somebody is working here" marks — the visible half of the blocks an agent
 * session publishes on its awareness state (server/utils/agent-peer.ts).
 *
 * The claim says which blocks the agent is on, so the human can look elsewhere
 * or watch, and knows a paragraph rewriting itself was not a glitch. It stands
 * while the agent is in the page and clears when it leaves.
 *
 * Read from awareness, never from the document: a claim describes a peer, and
 * peers come and go without touching content. It reserves nothing — a claimed
 * block takes keystrokes like any other.
 *
 * Built exactly like `./review-marks`: a node decoration carrying a class and
 * the label as an attribute, so nothing of ours is inserted between
 * collaboratively-edited blocks. See that module for why a widget would be
 * wrong here.
 */

/** Reads who, if anyone, claims a block. */
export type ClaimLookup = (blockId: string) => PresencePeer[]

/**
 * Projects the claims onto the document as node decorations. Pure over
 * (doc, lookup), so the projection tests without a view.
 *
 * The label is the marker, not the tint: it names who is working, and it is
 * what carries the state to a reader who does not see the colour.
 */
export function claimDecorations(doc: PMNode, lookup: ClaimLookup, viewerUid: number | null = null): DecorationSet {
  const decorations: Decoration[] = []
  for (const { id, pos, node } of addressableBlocks(doc)) {
    if (!id) continue
    const peers = lookup(id)
    if (peers.length === 0) continue
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      class: 'okb-claimed',
      'data-claim-label': claimLabel(peers, viewerUid),
    }))
  }
  return DecorationSet.create(doc, decorations)
}

export const agentMarksKey = new PluginKey<DecorationSet>('agentMarks')

/** Transaction meta that forces a rebuild without a document change. */
const REFRESH = 'okb-claim-refresh'

/**
 * The slice of an editor view a refresh needs: start a transaction, tag it,
 * dispatch it.
 *
 * Described structurally rather than as `EditorView`, because the session holds
 * its editor in a deep Vue ref and unwrapping strips the nominal types off
 * everything reachable through it — a `Transaction` from there is no longer a
 * `Transaction` to the compiler.
 */
export interface AgentMarksRefreshTarget {
  state: { tr: { setMeta: (key: string, value: unknown) => unknown } }
  dispatch: (tr: never) => void
}

/**
 * Rebuilds the marks against current awareness. A peer claiming or releasing
 * sends an awareness update and no document update, so nothing else would.
 */
export function refreshAgentMarks(view: AgentMarksRefreshTarget): void {
  view.dispatch(view.state.tr.setMeta(REFRESH, true) as never)
}

export function createAgentMarksPlugin(
  lookup: ClaimLookup,
  viewerUid: () => number | null = () => null,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: agentMarksKey,
    state: {
      init: (_config, state) => claimDecorations(state.doc, lookup, viewerUid()),
      apply(tr, value, _oldState, newState) {
        if (!tr.docChanged && !tr.getMeta(REFRESH)) return value
        return claimDecorations(newState.doc, lookup, viewerUid())
      },
    },
    props: {
      decorations: state => agentMarksKey.getState(state),
    },
  })
}

export interface AgentMarksOptions {
  /** Reads a block's claimants out of awareness. */
  lookup: ClaimLookup
  /** The reader's account, so their own agent is named as theirs. */
  viewerUid: () => number | null
}

export const AgentMarks = Extension.create<AgentMarksOptions>({
  name: 'agentMarks',

  addOptions() {
    return { lookup: () => [], viewerUid: () => null }
  },

  addProseMirrorPlugins() {
    return [createAgentMarksPlugin(this.options.lookup, this.options.viewerUid)]
  },
})
