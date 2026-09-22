<script setup lang="ts">
interface TocLink {
  id: string
  text: string
  depth: number
  children?: TocLink[]
}

const props = defineProps<{
  containerSelector?: string
  /** Passed through to `UContentToc`, for a host that frames it differently. */
  ui?: { trigger?: string }
}>()

const links = ref<TocLink[]>([])

/** A heading's own words — without the ¶ that links the block to itself. */
function headingText(h: HTMLElement): string {
  return Array.from(h.childNodes)
    .filter(n => !(n as HTMLElement).classList?.contains('okb-block-link'))
    .map(n => n.textContent ?? '')
    .join('')
}

function buildLinks(): TocLink[] {
  if (!import.meta.client) return []
  const root = document.querySelector(props.containerSelector ?? '.page-body')
  if (!root) return []
  // The outline is the page's own sections. A box's label and the headings
  // inside its body are chrome; slugging them would list them too.
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3'))
    .filter(h => !h.closest('.okb-box-title, .okb-box-body'))
  // The title heading is the page title's line in the body, hidden by the same
  // two selectors in NodeKbPage.vue — it is the page, not an entry in it.
  const title = root.querySelector(':scope > h1:first-child, :scope > :first-child > h1:first-child')
  const flat: TocLink[] = []
  for (const h of headings) {
    if (h === title) continue
    if (!h.id) {
      h.id = headingText(h).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    }
    if (!h.id) continue
    flat.push({
      id: h.id,
      text: headingText(h).trim(),
      depth: Number(h.tagName.slice(1)),
    })
  }
  // Nest h3 under preceding h2 / h1.
  const tree: TocLink[] = []
  for (const link of flat) {
    if (link.depth <= 2) {
      tree.push({ ...link, children: [] })
    }
    else {
      const parent = tree[tree.length - 1]
      if (parent) (parent.children ??= []).push(link)
      else tree.push({ ...link, children: [] })
    }
  }
  return tree
}

onMounted(() => {
  // Two-pass build: prosemirror/server HTML can mount after the page body
  // settles. Re-scan on the next tick to pick up content rendered later.
  links.value = buildLinks()
  nextTick(() => { links.value = buildLinks() })
})
</script>

<template>
  <UContentToc
    v-if="links.length"
    title="On this page"
    :links="links"
    highlight
    :ui="{ root: 'lg:sticky lg:top-4', ...props.ui }"
  />
</template>
