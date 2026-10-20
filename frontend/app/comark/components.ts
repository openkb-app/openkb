/**
 * The component set a comark body mounts, for `@comark/vue`'s renderer.
 *
 * One map for both surfaces — the page read view and a chat answer — so a
 * `::callout` in an answer is the same `CustomCallout` a published page
 * gets. The tree passes (`#shared/utils/comark-tree`) have already rewritten
 * every component tag to one this map has, `unknown` included.
 */
import { CustomAttachment, CustomCallout, CustomCitation, CustomCodeBlock, CustomDefault, CustomDoc, CustomImage, CustomInfobox } from '#components'
import { CODE_BLOCK_TAG, HTML_ELEMENTS, UNKNOWN_TAG } from '#shared/utils/comark-tree'
import { CITATION_TAG } from '#shared/utils/citations'

/**
 * Every HTML tag renders as itself. The pin is the guard: the renderer falls
 * back to the app's global components by PascalCase name, so an unpinned `p`
 * or `span` is one same-named component away from being captured — Nuxt UI
 * registers a `ProseP` and the rest globally.
 *
 * Typography is the utility both modes share (`okb-prose` in main.css), so a
 * native tag here is styled, not bare.
 */
const nativeHtml = Object.fromEntries(
  [...HTML_ELEMENTS].map(tag => [tag, tag]),
)

export const comarkComponents = {
  ...nativeHtml,
  callout: CustomCallout,
  infobox: CustomInfobox,
  image: CustomImage,
  attachment: CustomAttachment,
  doc: CustomDoc,
  [CITATION_TAG]: CustomCitation,
  [CODE_BLOCK_TAG]: CustomCodeBlock,
  [UNKNOWN_TAG]: CustomDefault,
}
