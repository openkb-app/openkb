import { fenceServers } from '#okb-fence-servers'
import { collectFences, parseComark } from '#shared/utils/comark-tree'
import { describeFenceError, fenceError, type FenceDefinition, type FenceRender } from '#shared/utils/fences'

/**
 * The server side of the fence components (shared/utils/fences.ts): each
 * fence's `server.ts`, loaded on first use.
 */

/** The read path's renderer: the HTML goes into the SSR HTML. */
export async function renderFence(fence: FenceDefinition, source: string, idPrefix: string): Promise<FenceRender> {
  const server = await fenceServers[fence.language]?.()
  if (!server?.render) return {}
  try {
    return server.render(source, { idPrefix })
  }
  catch (err) {
    return { error: fenceError(err) }
  }
}

/** Why the markdown's fence components are refused, one message per fence; empty when none is. */
export async function fenceErrors(markdown: string): Promise<string[]> {
  if (!/```|~~~/.test(markdown)) return []
  const found = collectFences(await parseComark(markdown))
  const out: string[] = []
  for (const [i, { fence, source }] of found.entries()) {
    const server = await fenceServers[fence.language]?.()
    const error = server?.check?.(source)
    if (!error) continue
    const which = found.length > 1 ? `${fence.label} ${i + 1}` : fence.label
    out.push(`${which} (${fence.languageLabel}): ${describeFenceError(error)}`)
  }
  return out
}
