<script setup lang="ts">
/**
 * A space's page tree — the sidebar's navigation and the space landing page's
 * contents list, one component so the two can never render differently.
 *
 * Reads and writes the shared outline (`useKbOutline`), so a drag here also
 * repaints the breadcrumbs of the page being read.
 *
 * Rearranging is offered only to sessions that may restructure the space;
 * enforcement is Drupal's either way — the access rule the outline route
 * applies.
 */
import { outlineTreeKey, type OutlineTreeController, type DropZone } from '~/utils/outline-tree'
import type { KbSpaceTree, KbTreeNode } from '#shared/utils/kb-outline'

const props = defineProps<{
  space: KbSpaceTree
  /** Sidebar density; the landing page renders roomier rows. */
  dense?: boolean
}>()

const route = useRoute()
const { move, trailFor } = useKbOutline()

// Explicit toggles only; everything else follows the active trail, so arriving
// on a deep page opens exactly the branch it sits in and nothing else. Kept in
// `useState` so the branch stays open across navigations.
const toggled = useState<Record<string, boolean>>('kb-outline-expanded', () => ({}))
const activeTrail = computed(() => trailFor(route.path).nodes.map(node => node.page.id))

function isExpanded(node: KbTreeNode): boolean {
  return toggled.value[node.page.id] ?? activeTrail.value.includes(node.page.id)
}

function setExpanded(id: string, value: boolean): void {
  toggled.value = { ...toggled.value, [id]: value }
}

// One gesture covers both drag axes: a row's upper or lower edge reorders among
// its siblings, its middle re-parents into it. The zone under the cursor is
// drawn as a line (reorder) or a ring (re-parent), so which one is about to
// happen is never guessed at.
const dragging = ref<string | null>(null)
const over = ref<{ id: string, zone: DropZone } | null>(null)

provide(outlineTreeKey, {
  space: computed(() => props.space),
  dense: computed(() => !!props.dense),
  dragging,
  over,
  isExpanded,
  setExpanded,
  toggle: node => setExpanded(node.page.id, !isExpanded(node)),
  move: (id, drop) => move(props.space, id, drop),
} satisfies OutlineTreeController)
</script>

<template>
  <ul
    class="flex flex-col"
    :class="dense ? 'gap-px' : 'gap-0.5'"
    data-testid="outline-tree"
    :data-space="space.slug ?? 'unassigned'"
    :data-can-restructure="space.canRestructure"
    @dragend="dragging = null; over = null"
  >
    <KbOutlineRow
      v-for="(node, index) in space.tree"
      :key="node.page.id"
      :node="node"
      :parent-id="null"
      :index="index"
    />
  </ul>
</template>
