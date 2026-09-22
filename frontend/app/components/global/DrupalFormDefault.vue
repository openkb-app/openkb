<script setup lang="ts">
/**
 * Any Drupal form the CE API sends, in this app's chrome.
 *
 * The connector resolves this whenever no `drupal-form-<form-id>` component
 * exists, so a Drupal form opened in the frontend has a home without a
 * component per form. Drupal renders the fields, the CSRF token and the
 * buttons into the default slot; this puts them in a real `<form>` posting back
 * to the page's own path, which is what makes such a form work with JavaScript
 * off. `title` is the form's own heading — for a confirm form, the question it
 * asks, which the route's generic title does not state.
 */
defineProps<{
  /** The form's heading, as Drupal-rendered HTML. */
  title?: string
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  method?: string
}>()

const { title: pageTitle, messages } = useKbCePage()

// The page's own path, so the submit lands back on the route that built the
// form. Read off the route rather than the request URL: a form reached by an
// in-app navigation must post to where the reader now is.
const action = useRoute().fullPath
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Breadcrumbs, not the navbar's own title: `UDashboardNavbar` renders
         that as an `h1`, and the form's heading belongs in its `main`. -->
    <ChromeAppNavbar :crumbs="[{ label: pageTitle }]" />
    <ChromePageBody>
      <main id="main-content" tabindex="-1" class="flex-1 focus:outline-none">
        <div class="mx-auto w-full max-w-[680px] px-4 py-8 sm:px-6 sm:py-10">
          <DrupalCeMessages :messages="messages" class="mb-6" />

          <!-- The form's own heading where it has one — for a confirm form that
               is the question it asks — and the route's title otherwise, so the
               page is never without one. -->
          <h1
            class="mb-6 text-[22px] font-bold leading-[1.2] tracking-tight text-highlighted sm:text-[26px]"
            v-html="title || pageTitle"
          />

          <form
            v-bind="attributes ?? {}"
            :method="method ?? 'post'"
            :action="action"
            class="drupal-form"
          >
            <slot />
          </form>
        </div>
      </main>
    </ChromePageBody>
  </div>
</template>
