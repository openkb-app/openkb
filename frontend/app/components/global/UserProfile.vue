<script setup lang="ts">
/**
 * The `user-profile` element: Drupal's account page at `/user/<uid>`, served
 * through the catch-all like every other CE payload. Reached from a presence
 * avatar, and from the account menu's own "My account".
 *
 * A read surface. What an account *is* stays Drupal's — this renders the props
 * its CE display sends and holds no account state of its own.
 */
import { collabColor, readableInkOn } from '#shared/utils/presence'
import { userInitials } from '#shared/utils/user'

const props = defineProps<{ uid?: number | string, name?: string }>()

// The color this person's caret and presence avatar carry, so the page reads
// as the avatar that was clicked.
const color = computed(() => collabColor(Number(props.uid) || 0))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <ChromeAppNavbar :title="name" />
    <ChromePageBody>
      <main id="main-content" tabindex="-1" class="flex-1 focus:outline-none">
        <div class="mx-auto flex w-full max-w-[900px] items-center gap-4 px-4 py-8 sm:px-6 sm:py-10">
          <!-- The theme's `fallback` slot carries `text-muted`; `text-current` hands it the root's ink. -->
          <UAvatar
            size="xl"
            :text="userInitials(name)"
            :style="{ backgroundColor: color, color: readableInkOn(color) }"
            :ui="{ fallback: 'text-current' }"
          />
          <h1
            data-testid="user-profile-name"
            class="text-[26px] font-bold leading-[1.15] tracking-tight text-highlighted sm:text-[32px]"
          >
            {{ name }}
          </h1>
        </div>
      </main>
    </ChromePageBody>
  </div>
</template>
