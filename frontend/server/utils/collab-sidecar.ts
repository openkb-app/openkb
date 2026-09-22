import * as Y from 'yjs'
import { initProseMirrorDoc } from '@tiptap/y-tiptap'
import { blockMetaRoot, fieldKey, pendingKey, toPageBlock, type PendingStep, type ReviewStep } from '#shared/page-blocks'
import { creditWriter, sessionWindow, type Ledger, type SessionWindow } from './collab-attribution'
import { dirtyFieldKeys } from './commit-fields'
import { TITLE_KEY } from './entity-fields'
import { editorSchema } from './editor-schema'

/**
 * The review flags this session's open window will earn, mirrored into the
 * live sidecar so a mark moves with the edit rather than with the checkpoint.
 *
 * ## What it derives identically, and what it does not
 *
 * {@link widened} is `\Drupal\openkb_workflow\PageBlocks::markPending()`:
 * given a block and an episode's writers, both widen the peer step's baseline
 * by those writers and drop the approvals the edit outdates, and a writer
 * carrying a `via` raises the agent step the same way. The rule matches.
 *
 * WHICH rule applies per block is the checkpoint's own decision, and this pass
 * always assumes the first of four
 * (`\Drupal\openkb_workflow\BlockAttribution::projected()`):
 *
 *  - a block the body diff calls changed is stamped as assumed here;
 *  - one the window names but the diff does not is carried, so a settled step
 *    stays settled;
 *  - one whose bytes end up equal to the published revision takes that
 *    revision's entry back, or loses its entry;
 *  - one changed with no writers on record is stamped unaccounted.
 *
 * So an estimate can appear and then go: restore a paragraph to the published
 * wording and the mark is drawn in a second and removed at the checkpoint. The
 * sidecar is best-effort data (ADR 0004) and Drupal's answer replaces this one
 * whole, so the pass takes the common case rather than re-deriving the body
 * diff and the published revision it would need for the rest.
 *
 * ## What it leaves behind
 *
 * `estimated` marks a flag as this pass's, so the pass can tell its own flags
 * from Drupal's; Drupal never writes the key. It is written into the Y.Doc,
 * which `@hocuspocus/extension-sqlite` persists with the rest of the document
 * — so it survives a restart, and it cannot survive a load: `onLoadDocument`
 * seeds from Drupal and `writeBlockMeta` drops every key Drupal does not name.
 *
 * It reaches Drupal on no path. The checkpoint body carries the text, the
 * window and `based_on_changed` — never the sidecar — and Drupal refuses the
 * field from a payload anyway (`openkb_workflow_entity_field_access()`). At the
 * next checkpoint of any kind `writeBlockMeta` aligns the map to exactly what
 * Drupal stores, which replaces every estimate or drops it.
 */
export function mirrorReviewFlags(doc: Y.Doc, window: SessionWindow): void {
  const root = blockMetaRoot(doc)
  const owed = new Set<string>()
  const writes = new Map<string, PendingStep>()

  for (const [id, writers] of Object.entries(window.blocks)) {
    const steps: Array<[ReviewStep, number[]]> = [
      ['peer', writers.map(w => w.uid)],
      ['agent', writers.filter(w => w.via !== null).map(w => w.uid)],
    ]
    for (const [step, uids] of steps) {
      if (uids.length === 0) continue
      const key = fieldKey(id, pendingKey(step))
      owed.add(key)
      const next = widened(stored(root, id, step), uids)
      if (!same(root.get(key), next)) writes.set(key, next)
    }
  }

  // An edit taken back leaves the window, and the estimate it earned has to
  // leave with it or the mark outlives the change it described. Only ours:
  // a witnessed flag is Drupal's to clear.
  const drops = [...root.keys()].filter(key => !owed.has(key) && estimatedKey(root, key))

  if (writes.size === 0 && drops.length === 0) return
  Y.transact(doc, () => {
    for (const [key, value] of writes) root.set(key, value)
    for (const key of drops) root.delete(key)
  })
}

/** A step's baseline widened by an episode's writers, its approvals dropped. */
function widened(current: PendingStep | undefined, uids: number[]): PendingStep {
  return { by: [...new Set([...(current?.by ?? []), ...uids])], ok: [], estimated: true }
}

/**
 * A step's pending entry as the document holds it — under the field key, or
 * inside a whole-block entry left by a session that predates the split.
 */
function stored(root: Y.Map<unknown>, id: string, step: ReviewStep): PendingStep | undefined {
  const field = root.get(fieldKey(id, pendingKey(step)))
  if (field) return field as PendingStep
  return toPageBlock(root.get(id))?.[pendingKey(step) as 'pending:peer']
}

/** Whether a key holds a flag this mirror wrote. */
function estimatedKey(root: Y.Map<unknown>, key: string): boolean {
  return !!(root.get(key) as PendingStep | undefined)?.estimated
}

function same(a: unknown, b: PendingStep): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b)
}

/** What {@link MarkMirror} needs of the plugin's per-document state. */
export interface MarkMirrorOptions {
  throttleMs: number
  /** The live document, or null once it is unloaded. */
  document: (documentName: string) => Y.Doc | null
  /** The document's attribution ledger, or null before one is attached. */
  ledger: (documentName: string) => Ledger | null
  /** Injectable timers/clock for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

/**
 * When the mirror runs, factored out of the Hocuspocus plugin so the pass is
 * testable with fake timers and no live WS server — the same reason
 * CheckpointScheduler (server/utils/commit-scheduler.ts) is a module of its own.
 *
 * The trigger is a writer's transaction. Leading edge: the first write of a
 * burst mirrors on the next tick, after the ops it was scheduled before have
 * landed, so the mark appears with the edit. Everything arriving inside the
 * interval that follows coalesces into the one pass at its end — a pass costs
 * one fragment→ProseMirror conversion plus one print of every block, which is
 * proportional to document size rather than to what moved.
 */
export class MarkMirror {
  private readonly opts: MarkMirrorOptions
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number
  private readonly docs = new Map<string, { at: number, timer: ReturnType<typeof setTimeout> | null }>()

  constructor(opts: MarkMirrorOptions) {
    this.opts = opts
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (handle => clearTimeout(handle))
    this.now = opts.now ?? (() => Date.now())
  }

  /** Books a pass for a document somebody is writing to. */
  schedule(documentName: string): void {
    const state = this.docs.get(documentName) ?? { at: 0, timer: null }
    this.docs.set(documentName, state)
    if (state.timer) return
    state.timer = this.setTimer(() => {
      state.timer = null
      state.at = this.now()
      this.run(documentName)
    }, Math.max(0, state.at + this.opts.throttleMs - this.now()))
  }

  /**
   * The pass: re-run the attribution over what has landed, and stamp the flags
   * it earns into the sidecar.
   *
   * Writes to the document and nowhere else. Drupal's ledger is untouched — no
   * checkpoint, no PATCH — and the ledger's durable half rides the writer
   * boundaries and the checkpoint (ADR 0005), so a crash is measured against
   * the same thing a crash was always measured against.
   */
  run(documentName: string): void {
    const doc = this.opts.document(documentName)
    const ledger = this.opts.ledger(documentName)
    if (!doc || !ledger?.hydrated) return
    creditWriter(ledger, initProseMirrorDoc(doc.getXmlFragment('default'), editorSchema).doc)
    mirrorReviewFlags(doc, sessionWindow(ledger, dirtyFieldKeys(doc).includes(TITLE_KEY)))
  }

  /** Drops a document's pending pass — nothing left to draw for it. */
  stop(documentName: string): void {
    const state = this.docs.get(documentName)
    if (state?.timer) this.clearTimer(state.timer)
    this.docs.delete(documentName)
  }

  stopAll(): void {
    for (const documentName of [...this.docs.keys()]) this.stop(documentName)
  }
}
