<script setup lang="ts">
/**
 * The shell: the rail, and one panel for the page. The page brings its own
 * header and, under it, the row that holds its body and the side pane
 * (`ChromePageBody`) — so the header spans both and the pane costs it no width.
 *
 * The skip link is the first focusable element in the document and jumps past
 * the sidebar's page tree — which can be dozens of links — to the `<main>` each
 * page renders. It is visually hidden until it takes focus.
 */
useAppShortcuts()

// The shell arms the flag every `wide` reads, so the pane and the controls that
// follow it arrive in one render rather than twelve.
const mounted = sidePaneMounted()
onMounted(() => { mounted.value = true })
</script>

<template>
  <UDashboardGroup>
    <a
      href="#main-content"
      data-testid="skip-link"
      class="sr-only z-50 rounded-md bg-primary px-4 py-2 text-sm font-medium text-inverted focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
    >
      Skip to content
    </a>
    <ChromeAppSidebar />
    <!-- The panel's default slot, not `#body`: the page lays its own header and
         row out, and the panel's scroller would scroll the header with them. -->
    <UDashboardPanel id="main">
      <slot />
    </UDashboardPanel>
    <ChromeChatLauncher />
    <ChatDrawer />
  </UDashboardGroup>
</template>
