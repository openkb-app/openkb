/**
 * How an actor is named where no viewer is known — the revision log and an
 * agent's own event feed: "fago", or "fago via claude" when the work was done
 * through an agent. What a person looking at the page reads is
 * {@link ownedLabel}.
 */
export function actorLabel(name: string, via?: string | null): string {
  return via ? `${name} via ${via}` : name
}

/**
 * How a person or agent is named to somebody looking at it. An agent names its
 * owner — one "claude" in a page could be several people's — except to the
 * owner, who reads their own agent by its bare name and mentions it that way.
 */
export function ownedLabel(
  who: { uid?: number | null, name?: string | null, via?: string | null },
  viewerUid?: number | null,
): string {
  if (!who.via) return who.name ?? ''
  return who.uid != null && who.uid === viewerUid
    ? who.via
    : actorLabel(who.name || 'somebody', who.via)
}
