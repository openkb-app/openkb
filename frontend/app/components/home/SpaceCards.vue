<script setup lang="ts">
// Every KB space the session may see, with its own description and its real
// page count — and, for a session that may create one, the CTA that does.

interface SpaceCard {
  id: string
  name: string
  slug: string
  description: string
  pages: number
}

defineProps<{
  spaces: SpaceCard[]
  /** Renders the create CTA — and the section itself on a KB with no spaces. */
  canCreate?: boolean
}>()
</script>

<template>
  <section v-if="spaces.length || canCreate">
    <header class="flex items-center gap-1.5 pb-2.5">
      <UIcon name="i-lucide-folders" class="size-[14px] text-muted" />
      <span class="text-[14px] font-semibold tracking-[-0.005em] text-highlighted">
        Spaces
      </span>
      <span class="text-[11.5px] text-muted">{{ spaces.length }}</span>
      <span v-if="canCreate" class="ml-auto">
        <NewSpaceButton size="xs" />
      </span>
    </header>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <NuxtLink
        v-for="space in spaces"
        :key="space.id"
        :to="`/${space.slug}`"
        class="flex flex-col gap-2 rounded-[12px] bg-default px-4 pb-3 pt-3.5 no-underline shadow-[0_0_0_1px_var(--ui-border)] transition hover:-translate-y-px hover:shadow-[inset_0_0_0_1px_var(--ui-border-accented),0_6px_18px_-8px_rgb(15_23_42_/_0.12)]"
      >
        <div class="flex items-center gap-2">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-(--ui-bg-muted) text-muted">
            <UIcon name="i-lucide-folder" class="size-4" />
          </span>
          <span class="min-w-0 flex-1 truncate text-[14px] font-semibold leading-[1.3] text-highlighted">
            {{ space.name }}
          </span>
          <span class="shrink-0 text-[11.5px] text-muted">
            {{ space.pages }} {{ space.pages === 1 ? 'page' : 'pages' }}
          </span>
        </div>
        <p v-if="space.description" class="m-0 line-clamp-2 text-[12.5px] leading-[1.5] text-muted">
          {{ space.description }}
        </p>
      </NuxtLink>
    </div>
  </section>
</template>
