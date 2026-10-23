<script setup lang="ts">
/**
 * The read page's attachments (ADR 0020): the page's files less those hidden
 * from the list, and those its text embeds, each as the file card, with
 * uploader and date. Only files this reader may download reach it
 * (server/utils/drupal-ce-enrich.ts).
 */
import type { PageAttachment } from '#shared/utils/files'

defineProps<{ files: PageAttachment[] }>()
</script>

<template>
  <section aria-labelledby="page-attachments-heading" class="mt-10 max-w-[720px]" data-test="page-attachments">
    <h2 id="page-attachments-heading" class="mb-3 text-sm font-semibold text-highlighted">
      Attachments
    </h2>
    <ul class="flex flex-col gap-2">
      <li v-for="file in files" :key="file.id">
        <AttachmentCard :file="file" :description="file.description" uploaded />
      </li>
    </ul>
  </section>
</template>
