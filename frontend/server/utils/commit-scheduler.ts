import type { CommitIdentity, CommitResult, CommitTrigger } from './commit'

/**
 * Per-document auto-checkpoint timing, factored out of the Hocuspocus plugin
 * so the trigger logic is testable with fake timers and no live WS server.
 *
 * Two dirty-window triggers, both env-tunable in the plugin:
 *   - quiet   — fires `quietMs` after the last edit (a settled session)
 *   - max-dirty — hard backstop `maxDirtyMs` after the first edit of a window,
 *                 so a continuously-edited doc still checkpoints
 *
 * Last-peer-disconnect is driven separately via {@link onDisconnect}, and an
 * agent ending its session checkpoints on the spot via {@link checkpoint}.
 * Whether a fired trigger actually writes a revision is the commit service's
 * call (idempotent hash dirty-check) — the scheduler only decides *when* to
 * try, and dedupes so overlapping triggers never run a commit concurrently.
 */

export interface CheckpointSchedulerOptions {
  quietMs: number
  maxDirtyMs: number
  /** `identity` overrides the document's captured session credentials — an
   *  agent commits under its own token, not under whoever authenticated last. */
  commit: (docName: string, trigger: CommitTrigger, identity?: CommitIdentity) => Promise<CommitResult>
  /** Injectable timers/clock for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface DocState {
  quiet: ReturnType<typeof setTimeout> | null
  max: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  /** Edits arrived while a commit was running — re-arm afterwards. */
  pending: boolean
  /** A disconnect trigger collided with a running commit — run it afterwards. */
  terminal: boolean
  /** The running commit, so {@link CheckpointScheduler.waitIdle} can await it. */
  current: Promise<void> | null
}

export class CheckpointScheduler {
  private readonly opts: CheckpointSchedulerOptions
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly docs = new Map<string, DocState>()

  constructor(opts: CheckpointSchedulerOptions) {
    this.opts = opts
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (handle => clearTimeout(handle))
  }

  private state(docName: string): DocState {
    let s = this.docs.get(docName)
    if (!s) {
      s = { quiet: null, max: null, inFlight: false, pending: false, terminal: false, current: null }
      this.docs.set(docName, s)
    }
    return s
  }

  /** Register an edit: (re)arm the quiet timer; arm the max-dirty backstop once. */
  onActivity(docName: string): void {
    const s = this.state(docName)
    if (s.quiet) this.clearTimer(s.quiet)
    s.quiet = this.setTimer(() => this.fire(docName, 'quiet'), this.opts.quietMs)
    if (!s.max) {
      s.max = this.setTimer(() => this.fire(docName, 'max-dirty'), this.opts.maxDirtyMs)
    }
  }

  /**
   * Checkpoint this document now, under `identity`, and report the outcome.
   *
   * Every caller-facing write comes through here (Save, Publish, Revert,
   * Approve, agent session end) and queues behind any running commit — two
   * concurrent commits on one document race each other's `_meta` and 409.
   * The wait is a loop: callers released together must re-check, since one
   * of them starts running before the others look.
   *
   * No `identity` is this server writing as itself — what delivering an owed
   * session statement after a caller's write needs.
   */
  async checkpoint(
    docName: string,
    trigger: CommitTrigger,
    identity?: CommitIdentity,
  ): Promise<CommitResult> {
    while (this.state(docName).inFlight) await this.waitIdle(docName)
    return this.run(docName, trigger, identity)
  }

  /** Last peer left (clientsCount === 0): checkpoint once, then go idle. */
  onDisconnect(docName: string, clientsCount: number): void {
    if (clientsCount > 0) return
    const s = this.docs.get(docName)
    if (s) this.clearTimers(s)
    void this.fire(docName, 'disconnect')
  }

  /**
   * Disarm a document's armed timers, keeping its state.
   *
   * What the settle path needs (server/utils/collab-control.ts): stop new
   * checkpoints from firing, then await {@link waitIdle} — which can only see
   * an in-flight commit while the state is still in the map, so {@link stop} is
   * the wrong tool there.
   */
  disarm(docName: string): void {
    const s = this.docs.get(docName)
    if (s) this.clearTimers(s)
  }

  /** Drop all timers and state for a document (e.g. on shutdown). */
  stop(docName: string): void {
    const s = this.docs.get(docName)
    if (s) this.clearTimers(s)
    this.docs.delete(docName)
  }

  stopAll(): void {
    for (const docName of [...this.docs.keys()]) this.stop(docName)
  }

  /** Both timers off, and no queued terminal run — disarm means disarm. */
  private clearTimers(s: DocState): void {
    if (s.quiet) { this.clearTimer(s.quiet); s.quiet = null }
    if (s.max) { this.clearTimer(s.max); s.max = null }
    s.terminal = false
  }

  /**
   * Resolve once no commit is running for this document. A reconcile that may
   * reset the fragment awaits this first, so it never compares Drupal's
   * `changed` against a `_meta` a mid-flight checkpoint is about to advance.
   */
  async waitIdle(docName: string): Promise<void> {
    for (;;) {
      const current = this.docs.get(docName)?.current
      if (!current) return
      await current.catch(() => {})
    }
  }

  private fire(docName: string, trigger: CommitTrigger): Promise<void> {
    const s = this.state(docName)
    if (s.inFlight) {
      // A commit is already running; never two at once. A quiet/max-dirty
      // trigger just leaves the window open and re-arms afterwards. A
      // disconnect cannot: the document unloads behind it, so nothing would
      // ever re-arm it — it runs as soon as the current commit settles.
      if (trigger === 'disconnect') s.terminal = true
      else s.pending = true
      return s.current ?? Promise.resolve()
    }
    return this.run(docName, trigger).then(() => {})
  }

  private run(
    docName: string,
    trigger: CommitTrigger,
    identity?: CommitIdentity,
  ): Promise<CommitResult> {
    const s = this.state(docName)
    s.inFlight = true
    this.clearTimers(s)
    const run = (async (): Promise<CommitResult> => {
      let result: CommitResult
      try {
        result = await this.opts.commit(docName, trigger, identity)
      }
      catch (err) {
        // Commit failures are surfaced to peers inside the commit service; the
        // scheduler just stops looping on them.
        result = { outcome: 'error', committed: false, message: (err as Error).message }
      }
      finally {
        s.inFlight = false
        s.current = null
        // A queued terminal run goes first and closes the window itself — the
        // document it belongs to is on its way out, so re-arming a timer for it
        // would only drop the work.
        if (s.terminal) {
          s.terminal = false
          s.pending = false
          void this.fire(docName, 'disconnect')
        }
        // A successful commit closes the dirty window; the next edit opens a
        // new one via onActivity (which re-arms both timers).
        else if (s.pending) {
          s.pending = false
          this.onActivity(docName)
        }
      }
      // Nothing follows a disconnect checkpoint, so a write it did not make is
      // a write nobody makes — on the record rather than lost quietly.
      if (trigger === 'disconnect' && !result.committed && !result.adopted && result.outcome !== 'clean') {
        console.error(
          `[collab] ${docName}: final checkpoint wrote nothing (${result.outcome})`
          + (result.message ? `: ${result.message}` : '')
          + ' — the last edits of this session are not in Drupal',
        )
      }
      return result
    })()
    s.current = run.then(() => {})
    return run
  }
}
