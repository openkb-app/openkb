<template>
  <!-- The pane's header row, at the navbar's height so the two read as one band
       across the app. A container: it is 288px wide in the pane and 496px in
       the slideover, and what fits differs by that much. -->
  <div class="@container/band flex min-h-(--ui-header-height) shrink-0 items-center gap-2 border-b border-default px-3">
    <slot />
  </div>
</template>
