import type { RouterConfig } from '@nuxt/schema'
import { START_LOCATION } from 'vue-router'

/**
 * Scrolling for navigation to a block (`/<space>/<slug>#b-…`).
 *
 * The dashboard scrolls inside a panel rather than the window, so a position
 * returned from here never arrives; and the page body is mounted from the CE
 * tree, so on a document load the block a fragment names is not in the page yet
 * when the browser looks for it. Waiting for it and scrolling to it is what
 * lands a deep link at all.
 */
export default <RouterConfig>{
  async scrollBehavior(to, from) {
    // Claimed before the early return: a navigation to no hash at all still
    // has to cancel a wait that is running, or it resolves on the next page
    // and hands the browser a fragment from the last one.
    const mine = ++generation
    if (!to.hash) return false
    const el = await waitFor(hashId(to.hash), mine)
    if (!el) return false
    // `:target` follows the document's own fragment, which a router push does
    // not touch, so one real fragment navigation is what sets it. That
    // navigation runs this again, so it happens only while the element is not
    // the target yet — otherwise the two never stop calling each other. A
    // document load has set it and scrolled already, and stepping on that one
    // aborts the load.
    if (from !== START_LOCATION && el !== document.querySelector(':target')) {
      location.replace(to.hash)
    }
    // Honours the block's `scroll-margin-top` (main.css), and reaches the panel
    // the page scrolls in rather than the window.
    el.scrollIntoView()
    return false
  },
}

/** The element id a fragment names; a malformed one is taken as written. */
function hashId(hash: string): string {
  const raw = hash.slice(1)
  try {
    return decodeURIComponent(raw)
  }
  catch {
    return raw
  }
}

/** The navigation whose scroll is current — an older wait stops when it is not. */
let generation = 0

/** Wait up to a second of frames for the target to reach the document. */
async function waitFor(id: string, mine: number): Promise<HTMLElement | null> {
  for (let i = 0; i < 60; i++) {
    if (generation !== mine) return null
    const el = document.getElementById(id)
    if (el) return el
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
  return null
}
