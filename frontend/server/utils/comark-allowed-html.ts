import { sharedFieldSource } from './drupal-fields'
import { drupalBaseUrl } from './drupal'
import type { AllowedHtml } from '#shared/utils/comark-tree'

/**
 * One source for every server-side consumer — the read page's CE enrichment
 * and the search-index projection — through the process-wide schema cache, so
 * a page render costs no extra request.
 */
export function bodyAllowedHtml(): Promise<AllowedHtml | undefined> {
  return sharedFieldSource(drupalBaseUrl()).fetchAllowedHtml()
}
