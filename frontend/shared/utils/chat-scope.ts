/**
 * What the chat's retrieval is scoped to, as the reader reads it.
 *
 * The scope travels to Drupal as a space's URL slug, or `all`; the name a
 * space carries is what the pill and the picker show.
 */

/** The scope that retrieves from every space the account may read. */
export const SCOPE_ALL = 'all'

/** What the whole-knowledge-base scope is called. */
export const SCOPE_ALL_LABEL = 'All spaces I can see'

/**
 * The label of a scope, by the spaces the session can see.
 *
 * A slug no loaded space carries is shown as itself: until the list arrives
 * the turn goes out scoped, and naming it the whole knowledge base meanwhile
 * would be the pill claiming a width the turn does not have.
 */
export function scopeLabel(scope: string, spaces: Array<{ slug: string, name: string }>): string {
  if (scope === SCOPE_ALL) return SCOPE_ALL_LABEL
  return spaces.find(space => space.slug === scope)?.name ?? scope
}
