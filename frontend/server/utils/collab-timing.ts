/**
 * The collab server's operator-tunable timing windows, read once at startup.
 *
 * One module so an environment has a single place to look and a single place
 * to set. Every value has its default in code, so an environment that sets
 * nothing behaves exactly as the defaults describe. Trade-offs per knob:
 * docs/collab-server.md ("Tuning").
 */

/** Read a positive-number env var, falling back when unset/blank/unparseable. */
function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return process.env[name] && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Settle window: how long a retiring document's `_meta.deleted_at` update gets
 * to reach peers before their sockets are closed. The write is broadcast
 * synchronously and a graceful WebSocket close flushes what is already queued,
 * so this is slack for the event loop rather than a transfer window.
 */
export const COLLAB_IDLE_MS = envMs('OKB_COLLAB_IDLE_MS', 100)

/** Auto-checkpoint this long after the last edit — a settled session. */
export const COLLAB_COMMIT_QUIET_MS = envMs('OKB_COLLAB_COMMIT_QUIET_MS', 5 * 60_000)

/**
 * Hard backstop: checkpoint this long after the first edit of a dirty window,
 * so a continuously-edited document still reaches Drupal.
 */
export const COLLAB_COMMIT_MAX_DIRTY_MS = envMs('OKB_COLLAB_COMMIT_MAX_DIRTY_MS', 30 * 60_000)

/**
 * Shortest gap between two runs of the review-mark mirror, which re-runs the
 * attribution pass and stamps the flags it earns into the live sidecar.
 *
 * Leading edge: the first write of a burst mirrors at once, so a mark follows
 * the edit that earns it. The throttle bounds what continuous typing costs —
 * one pass is one fragment->ProseMirror conversion plus one print of every
 * block, proportional to document size (0.9 ms on a 117 KiB page).
 */
export const COLLAB_MARK_THROTTLE_MS = envMs('OKB_COLLAB_MARK_THROTTLE_MS', 1_000)

/**
 * How long the body must stay quiet before a changed block is reported to a
 * watching agent (server/utils/session-events.ts). It is what makes an event a
 * paragraph rather than a keystroke, so it is also the watcher's latency.
 */
export const COLLAB_BLOCK_SETTLE_MS = envMs('OKB_COLLAB_BLOCK_SETTLE_MS', 3_000)

/**
 * The same for presence: awareness moves with every caret, and a watcher wants
 * "somebody is in this block", not a stream of positions.
 */
export const COLLAB_PRESENCE_SETTLE_MS = envMs('OKB_COLLAB_PRESENCE_SETTLE_MS', 1_000)

/**
 * How long an agent stays in a document's session after its last write
 * (server/utils/agent-sessions.ts).
 */
export const AGENT_SESSION_IDLE_MS = envMs('OKB_AGENT_SESSION_IDLE_MS', 3 * 60_000)

/**
 * Longest an agent session may hold the authorization it was opened under,
 * however busy it stays. The worst-case lag between Drupal revoking a token —
 * or a space withdrawing write access — and the write path noticing.
 */
export const AGENT_SESSION_MAX_MS = envMs('OKB_AGENT_SESSION_MAX_MS', 15 * 60_000)
