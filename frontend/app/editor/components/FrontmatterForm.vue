<script setup lang="ts">
/**
 * Schema-driven frontmatter form (OKB-47).
 *
 * Renders one input per field placed in the `frontmatter` form display, in
 * that display's order, with no hardcoded field list: the render model comes
 * from `/api/openkb/schema` (→ toFormModel) and every value binds through the
 * live session's `fields` Y.Map (useEntityFields), so edits are collaborative
 * and offline-durable exactly like the body.
 *
 * Placing / removing / reordering a field in the form display changes this
 * form with zero code changes. A schema-endpoint failure shows the branded
 * ErrorState (OKB-44) — status class only, no upstream leakage. Per-field
 * validation messages render from `errors`; that lane is fed by the commit
 * path's 422 mapping (OKB-48) and manually in tests.
 */
import type { FrontmatterFormApi } from '~/composables/useFrontmatterForm'
import type { EntityRef, FieldValue } from '~/composables/useEntityFields'
import { TITLE_KEY } from '~~/server/utils/entity-fields'

const { frontmatter } = defineProps<{ frontmatter: FrontmatterFormApi }>()

const {
  model, seeded, pending, error, errorStatus, errors, refresh,
  field, peersByField, focusField,
} = frontmatter

/** Field ids stay stable so a <label for> keeps pointing at its control. */
const fieldId = (key: string) => `frontmatter-${key}`

/** A number input hands back a string; store an actual number (or null). */
function setNumber(key: string, raw: string | number | null) {
  const binding = field(key)
  if (raw === '' || raw === null) { binding.value = null; return }
  const n = typeof raw === 'number' ? raw : Number(raw)
  binding.value = Number.isNaN(n) ? null : n
}
</script>

<template>
  <UCard
    :ui="{ root: 'mb-4 shadow-none ring-1 ring-default', body: 'p-4', header: 'px-4 py-2.5 border-b border-default bg-elevated/40' }"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-file-cog" class="size-4 text-muted" />
        <span class="text-[13px] font-semibold tracking-tight text-highlighted">Frontmatter</span>
        <span class="text-[11.5px] text-muted">Fields exposed for this page</span>
      </div>
    </template>

    <!-- Schema endpoint failed — branded, no leakage; retry re-fetches. -->
    <ErrorState
      v-if="error"
      :status-code="errorStatus"
      @retry="refresh"
    />

    <!-- Schema or session not ready yet. -->
    <div v-else-if="pending || !seeded" class="space-y-3" data-testid="frontmatter-loading">
      <div v-for="i in 3" :key="i" class="space-y-1.5">
        <div class="h-3 w-24 animate-pulse rounded bg-elevated" />
        <div class="h-8 w-full animate-pulse rounded bg-elevated" />
      </div>
    </div>

    <div v-else class="grid grid-cols-1 gap-3.5 sm:grid-cols-2" data-testid="frontmatter-fields">
      <!-- Node title: the one session field not in the schema (a base field).
           Rendered explicitly from TITLE_KEY — the single documented seam
           entity-fields.ts keeps out of the frontmatter contract. -->
      <div
        class="min-w-0 sm:col-span-2"
        data-field="title"
        data-widget="text"
        @focusin="focusField(TITLE_KEY)"
        @focusout="focusField(null)"
      >
        <div class="mb-1 flex items-center gap-1.5">
          <label :for="fieldId(TITLE_KEY)" class="block text-[12px] font-medium text-toned">
            Title <span class="text-error" aria-hidden="true">*</span>
          </label>
          <span
            v-for="peer in peersByField[TITLE_KEY] ?? []"
            :key="peer.clientId"
            class="inline-block size-2 rounded-full ring-2 ring-default"
            :style="{ backgroundColor: peer.color }"
            :title="`${peer.name} is editing`"
          />
        </div>
        <UInput
          :id="fieldId(TITLE_KEY)"
          v-model="field(TITLE_KEY).value"
          size="sm"
          class="w-full"
          :color="errors[TITLE_KEY]?.length ? 'error' : undefined"
        />
        <p
          v-for="(message, i) in errors[TITLE_KEY] ?? []"
          :key="i"
          :data-error-for="TITLE_KEY"
          class="mt-1 text-[11px] font-medium text-error"
        >
          {{ message }}
        </p>
      </div>

      <p
        v-if="model.length === 0"
        class="text-[12.5px] italic text-muted sm:col-span-2"
        data-testid="frontmatter-empty"
      >
        No additional frontmatter fields are exposed for this content type.
      </p>

      <div
        v-for="f in model"
        :key="f.key"
        :data-field="f.key"
        :data-widget="f.widget"
        class="min-w-0"
        :class="{ 'sm:col-span-2': f.widget === 'textarea' || f.multiple }"
        @focusin="focusField(f.key)"
        @focusout="focusField(null)"
      >
        <div class="mb-1 flex items-center gap-1.5">
          <label :for="fieldId(f.key)" class="block text-[12px] font-medium text-toned">
            {{ f.label }}
            <span v-if="f.required" class="text-error" aria-hidden="true">*</span>
          </label>
          <span
            v-for="peer in peersByField[f.key] ?? []"
            :key="peer.clientId"
            class="inline-block size-2 rounded-full ring-2 ring-default"
            :style="{ backgroundColor: peer.color }"
            :title="`${peer.name} is editing`"
          />
        </div>

        <!-- select (list_string) -->
        <USelect
          v-if="f.widget === 'select'"
          :id="fieldId(f.key)"
          v-model="field(f.key).value"
          :items="f.options"
          value-key="value"
          label-key="label"
          size="sm"
          class="w-full"
          :color="errors[f.key]?.length ? 'error' : undefined"
        />

        <!-- checkbox (boolean) -->
        <UCheckbox
          v-else-if="f.widget === 'checkbox'"
          :id="fieldId(f.key)"
          v-model="field(f.key).value"
          :label="f.description || f.label"
        />

        <!-- number (integer / decimal / float) -->
        <UInput
          v-else-if="f.widget === 'number'"
          :id="fieldId(f.key)"
          type="number"
          :model-value="(field(f.key).value as number | null) ?? ''"
          size="sm"
          class="w-full"
          :placeholder="f.placeholder"
          :color="errors[f.key]?.length ? 'error' : undefined"
          @update:model-value="setNumber(f.key, $event as string)"
        />

        <!-- textarea (string_long / text_long) -->
        <UTextarea
          v-else-if="f.widget === 'textarea'"
          :id="fieldId(f.key)"
          v-model="field(f.key).value"
          :rows="f.rows ?? 3"
          :placeholder="f.placeholder"
          size="sm"
          class="w-full"
          :color="errors[f.key]?.length ? 'error' : undefined"
        />

        <!-- reference (user / term autocomplete) -->
        <EditorFrontmatterReferenceField
          v-else-if="f.widget === 'reference'"
          :input-id="fieldId(f.key)"
          :model-value="field(f.key).value as EntityRef | EntityRef[] | null"
          :reference="f.reference!"
          :multiple="f.multiple"
          :placeholder="f.placeholder"
          :invalid="!!errors[f.key]?.length"
          @update:model-value="(value: FieldValue) => { field(f.key).value = value }"
        />

        <!-- text (string) -->
        <UInput
          v-else
          :id="fieldId(f.key)"
          v-model="field(f.key).value"
          size="sm"
          class="w-full"
          :placeholder="f.placeholder"
          :color="errors[f.key]?.length ? 'error' : undefined"
        />

        <!-- description, unless a checkbox already used it as its label -->
        <p v-if="f.description && f.widget !== 'checkbox'" class="mt-1 text-[11px] text-muted">
          {{ f.description }}
        </p>

        <!-- per-field validation errors (OKB-48 feeds these) -->
        <p
          v-for="(message, i) in errors[f.key] ?? []"
          :key="i"
          :data-error-for="f.key"
          class="mt-1 text-[11px] font-medium text-error"
        >
          {{ message }}
        </p>
      </div>
    </div>
  </UCard>
</template>
