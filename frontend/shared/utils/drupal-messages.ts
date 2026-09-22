/**
 * Drupal's messages for one CE page render.
 *
 * They arrive keyed by kind — `status` already renamed to `success` by
 * lupus_ce_renderer — and each entry is Drupal-rendered HTML.
 */
export interface DrupalMessages {
  success?: string[]
  warning?: string[]
  error?: string[]
}

/** One message, ready to render. */
export interface DrupalMessage {
  kind: keyof DrupalMessages
  html: string
}

/**
 * Flattens them in the order a reader should meet them: what went wrong, then
 * what to be careful about, then what worked.
 */
export function flattenDrupalMessages(messages?: DrupalMessages | null): DrupalMessage[] {
  const all = messages ?? {}
  return (['error', 'warning', 'success'] as const).flatMap(
    kind => (all[kind] ?? []).map(html => ({ kind, html })),
  )
}
