// Theme tokens for openKB v2. Mirrors design/prototype/styles.css.
//
// primary=blue + neutral=slate match the design's hex scales 1:1
// (--color-primary-* / --color-neutral-* in main.css are re-exposed
//  for direct var() reference from migrated markup).
//
// Status colors match the design (emerald success / amber warning /
// red error / cyan info — exact hex in main.css).

export default defineAppConfig({
  ui: {
    colors: {
      primary: 'blue',
      neutral: 'slate',
      success: 'emerald',
      warning: 'amber',
      error: 'red',
      info: 'cyan',
    },
    editor: {
      slots: {
        // The page's typography (`okb-prose` in main.css), plus what only
        // an editable surface has: its own gutter, the selection tint, the
        // mention chip, and what ProseMirror marks a selected node with.
        base: [
          'okb-prose',
          'w-full outline-none sm:px-8 selection:bg-primary/20',
          '[&_.mention]:text-primary [&_.mention]:font-medium',
          '[&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-primary',
          '[&_.ProseMirror-selectednode:not(img):not(pre):not([data-node-view-wrapper])]:bg-primary/20',
          // The rule's own hit area. Its wrapper carries the block margin and
          // the padding, so the pair totals the `<hr>`'s 3rem on the read side.
          '[&_[data-type=horizontalRule]]:my-10 [&_[data-type=horizontalRule]]:py-2 [&_[data-type=horizontalRule]_hr]:my-0',
        ].join(' '),
      },
    },
    icons: {
      loading: 'i-lucide-loader-circle',
      chevronDown: 'i-lucide-chevron-down',
      chevronRight: 'i-lucide-chevron-right',
      chevronLeft: 'i-lucide-chevron-left',
      check: 'i-lucide-check',
      close: 'i-lucide-x',
      search: 'i-lucide-search',
    },
  },
})
