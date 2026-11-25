import Link from '@tiptap/extension-link'

/**
 * The link mark, ranked below code (priority 100): Arrow-Right runs the higher
 * mark's exit first, so code exits and autolink unlinks the exit space.
 * Renders as the inner mark (`<code><a>`); shared by the editor and commit schema.
 */
export const OkbLink = Link.extend({ priority: 99 }).configure({ openOnClick: false })
