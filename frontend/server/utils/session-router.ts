import { createError } from 'h3'
import type { CommitResult, CommitTrigger, CommitIdentity } from './commit'
import { CommitValidationError } from './commit'
import { bearerAuthHeaders, drupalBaseUrl } from './drupal'
import { fetchUpstream, upstreamError } from './upstream'
import { createRefTypeResolver, fieldsPatchPayload } from './commit-fields'
import type { FieldSpec, FieldValues } from './entity-fields'
import {
  applyBodyMarkdown,
  openAgentSession,
  validateFieldOps,
  type AgentActor,
  type AgentOps,
  type AgentOpsResult,
  type AgentPeerHost,
  type AgentSession,
} from './agent-peer'
import {
  agentSessionKey,
  agentSessionRemainingMs,
  claimAgentWrites,
  heldAgentSession,
  holdAgentSession,
  keepAgentSessionAlive,
} from './agent-sessions'
import { joinAccessUrl, parseJoinAnswer } from './collab-join'

/**
 * Session router — the one way a write reaches OpenKB.
 *
 * Every write goes through the collaborative document: validate against the
 * exposure contract, join the live session (or start a headless one), apply
 * the ops as CRDT ops, let the session persist. There is deliberately no
 * JSON:API-direct fast path, not even for a single trivial field. A direct
 * PATCH would land behind the back of whatever session is open — the peers
 * would see the external-change banner and, worse, be one checkpoint away from
 * overwriting it — and it would put the write outside the review model the
 * whole design exists for (a human can join and watch an agent edit happen).
 * One route means one set of guarantees, and every write surface uses it: the
 * `updateFields` / `updateBlocks` MCP tools, `POST /api/agent/edit`, and the
 * `.md` PUT.
 *
 * ## One carrier: an agent Bearer token
 *
 * Humans edit in the collaborative editor, over the WebSocket gate. The write
 * surfaces here are the agent's, so the only carrier they take is a personal
 * consumer's Bearer token ({@link WriteCarrier}) — a browser cookie riding
 * along is ignored rather than honoured, so a session's wider permissions can
 * never mask the token's scope ceiling.
 *
 * ## The join gate is the security boundary
 *
 * `openDirectConnection` has no handshake, so nothing else authenticates a
 * peer opened this way. And admission *is* write control: the Y.Doc is a
 * shared buffer, so anyone admitted can influence content that a later
 * checkpoint commits — possibly a human's checkpoint, under that human's
 * credentials. The gate therefore runs per session opened, and asks Drupal
 * three questions:
 *
 *   1. is this token valid, and does it act as an agent? — the OKB-59 identity
 *      contract, `/openkb/agent/identity` under the token; simple_oauth
 *      rejects an invalid/expired/revoked token with a 401 that passes
 *      straight through, and a `via` label is what marks an agent carrier.
 *   2. does it carry the write ceiling? — the identity route reports the
 *      granted scope ids; a token without `agent_write` is refused by name so
 *      the client learns *which* ceiling it hit.
 *   3. may it update *this* node, and edit every field the session exposes? —
 *      `GET /openkb/node/<nid>/join-access` under the token: the same question
 *      the human WS gate asks, on the same route, answered by Drupal for this
 *      exact entity under the token's scope-capped permissions. A token whose
 *      owner lacks field access is refused like any other joiner — a token
 *      never exceeds its owner.
 *
 * Nitro enforces mechanically and decides nothing. (2) is a diagnostic
 * refinement of (3): a token lacking `agent_write` also lacks the edit
 * permission, so (3) alone would already refuse it — with a message pointing
 * at the node instead of at the scope.
 *
 * ## The session holds the decision
 *
 * All three answers belong to the session that was opened with them, and every
 * write on that session rides them. What bounds their age is the session's own
 * idle and absolute lifetimes (server/utils/agent-sessions.ts), which are also
 * the revocation lag: a token revoked mid-session is noticed when the session
 * closes. Sessions are keyed on the credential, so no caller can reach a
 * decision another credential earned.
 */

/** Why a join was refused — the taxonomy the gate's rejections map onto. */
export type JoinDenial =
  | 'unauthenticated' // no/invalid token, or a token that is not an agent's
  | 'scope' // valid agent token, but no agent_write
  | 'access' // valid, scoped, but no update access to this node

export class AgentJoinError extends Error {
  readonly denial: JoinDenial
  readonly statusCode: number
  constructor(denial: JoinDenial, message: string) {
    super(message)
    this.name = 'AgentJoinError'
    this.denial = denial
    this.statusCode = denial === 'unauthenticated' ? 401 : 403
  }
}

/** The scope an agent token must carry to write through a session. */
export const AGENT_WRITE_SCOPE = 'agent_write'

/** The agent Bearer token a write rides on; unset when none was presented. */
export interface WriteCarrier {
  token?: string
}

/** The carrier as upstream request headers. Empty when nothing was presented. */
export function carrierAuthHeaders(carrier: WriteCarrier): Record<string, string> {
  return carrier.token ? bearerAuthHeaders(carrier.token) : {}
}

/** What the identity route answers; `scopes` are the token's granted ones. */
export interface AgentIdentity {
  uid: number
  name: string
  via: string | null
  scopes: string[]
}

/**
 * A resolved write target: the node, and what a refusal calls it.
 *
 * A caller that addressed a page by path cannot map `node 12` back to what it
 * asked for, so every refusal names the target the caller's own way.
 */
export interface WriteSubject {
  nid: number
  /** The path the caller named, or `node <nid>` when it addressed by id. */
  name: string
}

/**
 * Why Drupal would not let this carrier write the node — read off the answer
 * it already gave, never a second question.
 */
export type WriteRefusal =
  /** It served the page and withheld the `Edit` task. */
  | 'read-only'
  /** It refused the read itself. */
  | 'unreadable'
  /** There is no page there. */
  | 'absent'

/** What Drupal answers about one carrier's access to one node. */
export interface NodeAccess {
  /** Node update, as Drupal decided it for the carrier's account. */
  allowed: boolean
  /** Session fields the account may not edit; null when Drupal did not say. */
  denied: string[] | null
  /** Why it said no. Set exactly when `allowed` is false. */
  refusal?: WriteRefusal
}

/**
 * What a refused write tells the caller.
 *
 * Each line is a fact about *this* request rather than a statement about
 * policy: a served page proves reads work and a withheld `Edit` task proves
 * writes do not; a refused read says only that these credentials could not
 * read it; a missing page is not an access answer at all, and dressing it
 * as one would send an agent hunting a permission it never lacked. No space
 * name, roster or rule appears in any of them.
 */
function refusalMessage(refusal: WriteRefusal | undefined, name: string): string {
  switch (refusal) {
    case 'read-only':
      return `No write access to ${name}: these credentials may read it but not change it.`
    case 'unreadable':
      return `These credentials cannot access ${name}.`
    case 'absent':
      return `There is no page at ${name}.`
    default:
      return `No write access to ${name}.`
  }
}

/** The Drupal questions the gate asks — injected so the router unit-tests. */
export interface GateDeps {
  /** `GET /openkb/agent/identity` under the carrier. Throws on a 401. */
  fetchIdentity: (auth: Record<string, string>) => Promise<AgentIdentity>
  /** May the carrier's account update this node, and edit its session fields? */
  checkNodeAccess: (auth: Record<string, string>, nid: number) => Promise<NodeAccess>
}

/**
 * Runs checks (1) and (2) — who the token is, and whether it carries the write
 * ceiling. Node access (3) is {@link authorizeSessionWrite}'s half.
 *
 * Split out because it needs no target: a transport can authenticate before it
 * has parsed the payload, which is what makes "no/invalid credentials plus a
 * malformed body" a 401 rather than a 400. Credentials are the first thing a
 * caller gets wrong and the first thing they should hear about; reporting a
 * body problem to an unauthenticated caller also tells them something about
 * the API they have not earned.
 *
 * `subject` names the page in the scope refusal where the caller has already
 * named one. The missing scope is the credential's, not the page's, so the
 * wording says so either way.
 */
export async function authenticateWriter(
  deps: GateDeps,
  carrier: WriteCarrier,
  subject?: string,
): Promise<AgentActor> {
  const auth = carrierAuthHeaders(carrier)
  if (!carrier.token) {
    throw new AgentJoinError('unauthenticated', 'An agent token is required to edit.')
  }

  let identity: AgentIdentity
  try {
    identity = await deps.fetchIdentity(auth)
  }
  catch (err) {
    // simple_oauth's rejection of a bad/expired/revoked token. Anything else
    // (Drupal down) is not an authorization answer and must not read as one.
    const status = (err as { statusCode?: number }).statusCode
    if (status === 401 || status === 403) {
      throw new AgentJoinError('unauthenticated', 'The credentials were rejected.')
    }
    throw err
  }

  // A token carrying no agent scope is not an agent carrier — it must not
  // reach the session under the agent contract.
  if (!identity.uid || !identity.via) {
    throw new AgentJoinError('unauthenticated', 'An agent token is required to join a session.')
  }
  if (!identity.scopes.includes(AGENT_WRITE_SCOPE)) {
    throw new AgentJoinError(
      'scope',
      `These credentials cannot edit${subject ? ` ${subject}` : ''}: the `
      + `"${AGENT_WRITE_SCOPE}" scope is missing. Whoever manages this API `
      + 'client can add it.',
    )
  }

  return { token: carrier.token, uid: identity.uid, name: identity.name, via: identity.via }
}

/**
 * Runs all three checks and returns the actor to act as.
 *
 * `authenticated` lets a transport that already ran {@link authenticateWriter}
 * (for the 401-before-400 ordering) skip the repeated identity round-trip.
 *
 * Called once per session, not once per write — {@link routeAgentEdit} reuses
 * the decision for as long as the session holding it stands.
 *
 * Throws {@link AgentJoinError}; nothing partially-authorized ever escapes.
 */
export async function authorizeSessionWrite(
  deps: GateDeps,
  carrier: WriteCarrier,
  subject: WriteSubject,
  authenticated?: AgentActor,
): Promise<AgentActor> {
  const actor = authenticated ?? await authenticateWriter(deps, carrier, subject.name)
  const { allowed, denied, refusal } = await deps.checkNodeAccess(carrierAuthHeaders(carrier), subject.nid)
  if (!allowed) {
    throw new AgentJoinError('access', refusalMessage(refusal, subject.name))
  }
  // Admission is write control, so the fields the session exposes are part of
  // it. A denial Drupal did not answer at all is refused the same way — see
  // ./collab-join.ts.
  if (denied === null) {
    throw new AgentJoinError('access', `The site did not answer the field-access check for ${subject.name}.`)
  }
  if (denied.length > 0) {
    throw new AgentJoinError('access', `No edit access to ${denied.join(', ')} on ${subject.name}.`)
  }
  return actor
}

/** Live gate deps, talking to the configured Drupal. */
export function drupalGateDeps(): GateDeps {
  return {
    async fetchIdentity(auth: Record<string, string>): Promise<AgentIdentity> {
      const res = await fetchUpstream(`${drupalBaseUrl()}/openkb/agent/identity`, {
        headers: { Accept: 'application/json', ...auth },
      })
      if (!res.ok) throw await upstreamError(res, 'agent identity')
      const identity = await res.json() as Partial<AgentIdentity>
      return {
        uid: Number(identity.uid) || 0,
        name: identity.name ?? '',
        via: identity.via ?? null,
        scopes: Array.isArray(identity.scopes) ? identity.scopes : [],
      }
    },

    async checkNodeAccess(auth: Record<string, string>, nid: number): Promise<NodeAccess> {
      // Both halves in one answer, decided by Drupal for this entity under the
      // carrier's ceiling.
      const res = await fetchUpstream(joinAccessUrl(drupalBaseUrl(), nid), {
        headers: { Accept: 'application/json', ...auth },
      })
      // Only a 403 or a 404 is Drupal answering the access question. Anything
      // else — a 5xx, an unreachable site — is an outage, and reporting it as
      // a denial would make an agent abandon a page it owns.
      if (res.status === 403) return { allowed: false, denied: null, refusal: 'unreadable' }
      if (res.status === 404) return { allowed: false, denied: null, refusal: 'absent' }
      if (!res.ok) throw await upstreamError(res, 'node access')

      const answer = parseJoinAnswer(await res.json())
      return answer.update
        ? { allowed: true, denied: answer.denied }
        : { allowed: false, denied: null, refusal: 'read-only' }
    },
  }
}

/** Thrown when ops do not fit the exposure contract; nothing was written. */
export class AgentOpsError extends Error {
  readonly fields: Record<string, string[]>
  constructor(fields: Record<string, string[]>) {
    super('Validation failed')
    this.name = 'AgentOpsError'
    this.fields = fields
  }
}

/**
 * Validates field *values* the way the commit will write them — the same
 * mapper (server/utils/commit-fields.ts), so a value this accepts is a value
 * the PATCH accepts.
 *
 * It runs before the session is joined, which is the whole point: a reference
 * that does not resolve is caught while the document is still untouched. Left
 * to commit time it would fail *after* the ops are in the shared Y.Doc, where
 * the human peers can already see them and the next checkpoint would keep
 * retrying a write Drupal will never take.
 *
 * The resulting payload is discarded — the commit rebuilds it from the doc.
 */
export async function validateFieldValues(
  specs: FieldSpec[],
  values: FieldValues,
  auth: Record<string, string>,
): Promise<void> {
  await fieldsPatchPayload(specs, values, Object.keys(values), createRefTypeResolver(auth))
}

export interface RouterDeps extends GateDeps {
  host: AgentPeerHost
  /** Exposed fields per the frontmatter form display, or null when unreachable. */
  fetchSpecs: () => Promise<FieldSpec[] | null>
  /** Value-level validation; throws {@link CommitValidationError}. */
  validateValues: (specs: FieldSpec[], values: FieldValues, auth: Record<string, string>) => Promise<void>
  /** Drupal's canonical body for a node, or null when unreachable. */
  fetchBody: (nid: number) => Promise<string | null>
  /**
   * Records the carrier a document's Drupal reads run under, before the
   * document loads. See {@link captureHeadlessCarrier}.
   */
  captureCarrier: (documentName: string, identity: CommitIdentity) => void
  /** Persist the document now, under this identity. Deduped by the scheduler. */
  checkpoint: (docName: string, trigger: CommitTrigger, identity: CommitIdentity) => Promise<CommitResult>
}

export interface AgentEditResult {
  nid: number
  /**
   * Whether this writer's session joined a room that was already live or
   * started it. Read from the session, so a reused one keeps reporting what it
   * found when it opened.
   */
  entry: 'joined' | 'started'
  /** Browser peers connected while the ops were applied. */
  observers: number
  applied: AgentOpsResult
}

/**
 * Fills a headless session's body fragment from Drupal before anything is
 * written from it.
 *
 * Server-side seeding (server/utils/doc-seed.ts) records the body's *hash* on
 * first load but leaves the fragment empty — a browser peer hydrates it from
 * the same body it fetches for itself. A session nobody is in has no such
 * peer, so a write that does not carry a body of its own would serialize an
 * empty document and hand Drupal a blank one. What saves the page today is
 * that `field_kb_body` is required and the PATCH 422s; on a nullable body it
 * would silently erase it.
 *
 * Runs once, when the session opens. Only for a session it *started*, and only
 * when the fragment is genuinely empty: in a live session the peers own the
 * fragment, and an empty one there may be a deletion they have not committed
 * yet.
 *
 * It hydrates from the **working copy** — the revision the commit will be
 * based on. On a moderated page (OKB-64) that is a forward draft whenever
 * one exists, and the published default is a different body: hydrating from it
 * would hand the commit the published text plus this write's ops, silently
 * reverting whatever the draft held. That read needs a carrier, which is what
 * {@link captureHeadlessCarrier} puts in place.
 *
 * The hydration is not tagged as an agent op — it restores Drupal's own
 * content rather than authoring anything, and the resulting document
 * serializes back to the baseline hash, so the commit still sees the body as
 * clean and writes it back unchanged.
 */
async function hydrateHeadlessBody(
  deps: RouterDeps,
  session: AgentSession,
  nid: number,
): Promise<void> {
  if (session.entry !== 'started') return
  if (session.doc.getXmlFragment('default').length > 0) return
  const body = await deps.fetchBody(nid)
  if (!body) return
  applyBodyMarkdown(session.doc, body)
}

/**
 * Hands the document this writer's carrier before it loads, when the writer is
 * the one starting it.
 *
 * Every Drupal read the document makes — the seed lanes for body, `changed`,
 * fields and the provenance sidecar — runs under the carrier captured for it,
 * because those lanes have no request of their own. A document a human opened
 * has their session cookie from the WebSocket handshake; a document an agent
 * starts has nothing, and on a moderated page (OKB-64) "nothing" means
 * anonymous, which may not read a working copy at all: the session would be
 * seeded from the published revision, or not at all, and the write would commit
 * against the wrong body.
 *
 * Runs once, when the session opens, and only for a document nobody is in. In a
 * live session the carrier belongs to the humans editing it, and replacing it
 * would attribute their next timer-driven checkpoint to this agent.
 */
function captureHeadlessCarrier(deps: RouterDeps, nid: number, identity: CommitIdentity): void {
  const documentName = `node:${nid}`
  if (deps.host.documents.has(documentName)) return
  deps.captureCarrier(documentName, identity)
}

/**
 * Refuses a whole-document body on an existing page.
 *
 * An agent is a peer, and a peer edits the blocks it means to edit. Handing in
 * a replacement body is a claim about *every* block in the page — including
 * the ones a human is typing in right now, and the ones a reviewer has already
 * signed off, which such a write would silently re-open. The block surface
 * says only what it means, and Drupal flags exactly those blocks.
 *
 * Creating a page names no blocks at all: `tool_api__create_page` takes a
 * title and a space, and seeds the one block the first `updateBlocks` anchors
 * on.
 */
function refuseWholeBody(ops: AgentOps): void {
  if (ops.body === undefined) return
  throw createError({
    statusCode: 422,
    statusMessage:
      'An agent edits an existing page block by block: pass "blocks" naming '
      + 'the blocks to change, not a whole "body".',
  })
}

/** The actor as the commit layer names it. */
function commitIdentityOf(actor: AgentActor): CommitIdentity {
  return { token: actor.token, user: actor.name, via: actor.via ?? undefined }
}

/**
 * Opens a session for this writer, seeds it, and registers it so the calls that
 * follow find the agent already in the room.
 */
async function startAgentSession(
  deps: RouterDeps,
  key: string,
  nid: number,
  actor: AgentActor,
): Promise<AgentSession> {
  const identity = commitIdentityOf(actor)
  captureHeadlessCarrier(deps, nid, identity)
  const session = await openAgentSession(deps.host, nid, actor)
  await hydrateHeadlessBody(deps, session, nid)
  holdAgentSession(key, {
    session,
    actor,
    persist: async () => {
      // Only when the agent is the last peer standing. With a browser peer
      // connected that session's own checkpoint rules already own persistence,
      // and committing here would put the human's in-flight edits into a
      // revision they did not trigger.
      if (session.humanPeers() > 0) return false
      const result = await deps.checkpoint(session.documentName, 'agent', identity)
      // `clean` is the document already holding what Drupal holds — nothing of
      // this session's is left pending either way.
      return result.committed || result.outcome === 'clean'
    },
  })
  return session
}

/** A joined session, and what a call riding it needs from the registry. */
export interface JoinedAgentSession {
  session: AgentSession
  /** Hold the idle window open for this call; the answer releases it. */
  keepAlive: () => () => void
  /** The longest this call may run before the session's age cap ends it. */
  remainingMs: number
}

/**
 * The session this carrier holds on the node, opening one if it holds none.
 *
 * The way in for a caller that watches rather than writes
 * (server/utils/session-events.ts): the events are derived from the live
 * Y.Doc, so watching a document means being admitted to it on write terms.
 */
export async function joinAgentSession(
  deps: RouterDeps,
  carrier: WriteCarrier,
  subject: WriteSubject,
): Promise<JoinedAgentSession> {
  const key = agentSessionKey(subject.nid, carrier)
  const held = await heldAgentSession(key)
  const session = held?.session
    ?? await startAgentSession(deps, key, subject.nid, await authorizeSessionWrite(deps, carrier, subject))
  return {
    session,
    keepAlive: () => keepAgentSessionAlive(key),
    remainingMs: agentSessionRemainingMs(key),
  }
}

/**
 * Routes one edit: authorize → validate → join/start → apply.
 *
 * ## The session outlives the call
 *
 * An agent is mid-conversation: it stays in the room between tool calls
 * (server/utils/agent-sessions.ts). A call that finds its session already open
 * reuses it and asks Drupal nothing — the gate's three answers were bound to
 * that session when it opened.
 *
 * Persistence belongs to the session: the document's
 * `onChange` arms the checkpoint scheduler for every mutation, agent origins
 * included, and a lapsing session checkpoints once on its way out when no
 * browser peer is left to do it. So acceptance by the session *is* the answer
 * the caller gets — Drupal's verdict arrives at a checkpoint, and what this
 * layer can decide it decides before joining, above.
 *
 * ## One revision, one author
 *
 * A checkpoint serializes the whole document, so it can only be signed by the
 * actor whose ops it carries. A second credential writing the same node takes
 * the document over and checks the previous writer's work in under *that*
 * writer first (server/utils/agent-sessions.ts) — the reason the sessions may
 * overlap in the room at all without their work overlapping in a revision.
 */
export async function routeAgentEdit(
  deps: RouterDeps,
  carrier: WriteCarrier,
  subject: WriteSubject,
  ops: AgentOps,
  authenticated?: AgentActor,
): Promise<AgentEditResult> {
  const { nid } = subject
  const key = agentSessionKey(nid, carrier)
  const held = await heldAgentSession(key)
  const actor = held?.actor ?? await authorizeSessionWrite(deps, carrier, subject, authenticated)
  refuseWholeBody(ops)

  // Validate before joining: a rejected op must not leave a bot flickering in
  // the presence strip, and must never be half-applied.
  if (ops.fields) {
    const specs = await deps.fetchSpecs()
    if (specs === null) {
      throw createError({ statusCode: 503, statusMessage: 'The field schema is unavailable.' })
    }
    const errors = validateFieldOps(specs, ops.fields)
    if (Object.keys(errors).length > 0) throw new AgentOpsError(errors)
    try {
      await deps.validateValues(specs, ops.fields, carrierAuthHeaders(carrier))
    }
    catch (err) {
      if (err instanceof CommitValidationError) throw new AgentOpsError(err.fields)
      throw err
    }
  }

  const session = held?.session ?? await startAgentSession(deps, key, nid, actor)
  // One revision, one author: whoever wrote here before checks their work in
  // under their own name before this session's ops join it in the document.
  if (await claimAgentWrites(key)) {
    // The handover left the document clean, so what a timer-driven checkpoint
    // would serialize is this session's work — its credit follows.
    deps.captureCarrier(session.documentName, commitIdentityOf(actor))
  }
  const applied = session.apply(ops)
  return { nid, entry: session.entry, observers: session.humanPeers(), applied }
}
