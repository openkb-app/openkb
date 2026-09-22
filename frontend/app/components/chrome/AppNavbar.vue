<script setup lang="ts">
interface Crumb {
  label: string
  icon?: string
  to?: string
}

defineProps<{
  crumbs?: Crumb[]
  title?: string
}>()

const { content: paneContent, hidden: paneHidden, wide: paneWide, show: showPane } = useSidePane()
</script>

<template>
  <UDashboardNavbar
    as="header"
    :title="title"
    :toggle="{ class: 'shrink-0' }"
    :ui="{ root: '@container/editnav sticky top-0 z-30 bg-default/95 backdrop-blur supports-[backdrop-filter]:bg-default/80 h-(--ui-header-height) shrink-0 flex items-center justify-between border-b border-default px-4 sm:px-6 gap-1.5' }"
  >
    <template #leading>
      <!-- Pages may take over the leading space (e.g. the read page swaps
           in the editor toolbar while editing); breadcrumbs are the default. -->
      <slot name="leading">
        <UBreadcrumb
          v-if="crumbs?.length"
          :items="crumbs.map(c => ({ label: c.label, icon: c.icon, to: c.to }))"
          :ui="{ root: 'min-w-0', label: 'truncate' }"
        />
      </slot>
    </template>

    <template #right>
      <!-- Page actions only. The session identity + account menu lives once, in
           the sidebar footer (ChromeUserMenu there); a second copy here was the
           same control twice on screen. The header's left side is min-width-0,
           so whatever sits here keeps its width and the breadcrumb trail
           truncates first — the trail is the orientation device, but a control
           you cannot read is not one. -->
      <slot name="actions" />

      <!-- Only when the reader put the pane away: the one way back to it. The
           pane's own header carries the control that hides it. `wide` is the
           same gate the pane itself is under — false until the app has
           mounted, so both renders of this control agree on nothing. -->
      <UButton
        v-if="paneWide && paneContent && paneHidden"
        icon="i-lucide-panel-right-open"
        color="neutral"
        variant="ghost"
        size="sm"
        data-testid="side-pane-show"
        aria-label="Show the side pane"
        class="shrink-0"
        @click="showPane({ focus: true })"
      />
    </template>
  </UDashboardNavbar>
</template>
