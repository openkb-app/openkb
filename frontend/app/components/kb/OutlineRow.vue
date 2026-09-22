<script setup lang="ts">
/**
 * One page in a space's tree, and — recursively — everything below it.
 *
 * The row is the drag unit: it is the drag source, the drop target and the
 * expand/collapse control, so a subtree moves as one thing without the tree
 * above needing to know how deep it is.
 */
import { dropFor, outlineTreeKey, zoneAt } from '~/utils/outline-tree'
import type { KbTreeNode } from '#shared/utils/kb-outline'

const props = defineProps<{
  node: KbTreeNode
  parentId: string | null
  index: number
}>()

const tree = inject(outlineTreeKey)!
const route = useRoute()

const id = computed(() => props.node.page.id)
const hasChildren = computed(() => props.node.children.length > 0)
const expanded = computed(() => tree.isExpanded(props.node))
const isCurrent = computed(() => route.path === props.node.page.path)
const canDrag = computed(() => tree.space.value.canRestructure)
const isDragging = computed(() => tree.dragging.value === id.value)
const zone = computed(() => (tree.over.value?.id === id.value ? tree.over.value.zone : null))

function onDragStart(event: DragEvent): void {
  // Rows nest, and drag events bubble: without this an ancestor row would
  // overwrite the drag with itself and move the wrong subtree.
  event.stopPropagation()
  tree.dragging.value = id.value
  event.dataTransfer?.setData('text/plain', id.value)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent): void {
  event.stopPropagation()
  if (!tree.dragging.value || tree.dragging.value === id.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  tree.over.value = { id: id.value, zone: zoneAt(event) }
}

function onDragLeave(event: DragEvent): void {
  event.stopPropagation()
  if (tree.over.value?.id === id.value) tree.over.value = null
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const dragged = tree.dragging.value
  const where = zone.value ?? zoneAt(event)
  tree.dragging.value = null
  tree.over.value = null
  if (!dragged || dragged === id.value) return
  // A page dropped into this one must be visible where it landed.
  if (where === 'inside') tree.setExpanded(id.value, true)
  tree.move(dragged, dropFor(props.node, where, props.parentId, props.index))
}
</script>

<template>
  <li
    class="relative"
    data-testid="outline-row"
    :data-page-id="id"
    :data-depth="node.depth"
    :draggable="canDrag"
    @dragstart="onDragStart"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Drop affordances. Neither changes the row's box, so the tree does not
         jump while a drag hovers over it. -->
    <span
      v-if="zone === 'before'"
      class="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 rounded bg-primary"
    />
    <span
      v-if="zone === 'after'"
      class="pointer-events-none absolute inset-x-0 -bottom-px z-10 h-0.5 rounded bg-primary"
    />

    <div
      class="group flex items-center rounded-md"
      :class="[
        zone === 'inside' ? 'ring-2 ring-primary ring-inset' : '',
        isDragging ? 'opacity-40' : '',
      ]"
    >
      <!-- Indentation is padding on the row, not a nested box, so the hover
           and active backgrounds still span the sidebar's full width. -->
      <button
        v-if="hasChildren"
        type="button"
        class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed hover:text-highlighted"
        :style="{ marginInlineStart: `${node.depth * 12}px` }"
        data-outline-toggle
        :aria-expanded="expanded"
        :aria-label="expanded ? `Collapse ${node.page.title}` : `Expand ${node.page.title}`"
        @click="tree.toggle(node)"
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="size-3.5 transition-transform"
          :class="expanded ? 'rotate-90' : ''"
        />
      </button>
      <span
        v-else
        class="size-5 shrink-0"
        :style="{ marginInlineStart: `${node.depth * 12}px` }"
      />

      <NuxtLink
        :to="node.page.path"
        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-toned hover:bg-elevated hover:text-highlighted"
        :class="[
          tree.dense.value ? 'py-1 text-[13px]' : 'py-1.5 text-[13.5px]',
          isCurrent ? 'bg-primary/12 font-medium text-primary-700 dark:text-primary-300' : '',
        ]"
        :aria-current="isCurrent ? 'page' : undefined"
      >
        <UIcon name="i-lucide-file-text" class="size-3.5 shrink-0 text-muted" />
        <span class="truncate">{{ node.page.title }}</span>
      </NuxtLink>

      <UIcon
        v-if="canDrag"
        name="i-lucide-grip-vertical"
        class="mr-1 size-3.5 shrink-0 cursor-grab text-dimmed opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
    </div>

    <ul v-if="hasChildren && expanded" class="flex flex-col" :class="tree.dense.value ? 'gap-px' : 'gap-0.5'">
      <KbOutlineRow
        v-for="(child, childIndex) in node.children"
        :key="child.page.id"
        :node="child"
        :parent-id="id"
        :index="childIndex"
      />
    </ul>
  </li>
</template>
