/**
 * What a failed request said, in words the reader can act on.
 *
 * The sentence sits at either of two depths — `$fetch` hands the body over as
 * `err.data`, h3 nests `createError`'s own `data` under it. A per-field
 * message wins, and only the first: the sync chip reading this has room for
 * one sentence, and the form slots carry the rest.
 */
export function serverMessage(err: unknown): string | null {
  const e = err as {
    statusMessage?: string
    data?: {
      statusMessage?: string
      fields?: Record<string, string[]>
      data?: { fields?: Record<string, string[]> }
    }
  }
  const fields = e?.data?.data?.fields ?? e?.data?.fields
  const perField = Object.values(fields ?? {}).flat().filter(Boolean)
  return perField[0] ?? e?.data?.statusMessage ?? e?.statusMessage ?? null
}
