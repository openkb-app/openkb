<script setup lang="ts">
/**
 * `/help/shortcuts` — one read-style page for what the editor understands when
 * typed and which keys the app answers to. Reached from the account menu and
 * from the page's ⋯ menu.
 *
 * The rows come from `~/utils/help-shortcuts`, which sits next to the code they
 * describe; this page only lays them out. Each section is a `<section>` with a
 * real heading and a `<table>`: keys and typed sequences are `<kbd>`, a stored
 * markdown spelling is `<code>`, so a screen reader gets the same structure a
 * reader sees.
 */
import {
  appShortcuts,
  editorShortcuts,
  markdownRules,
  shortcutKeys,
  typedTriggers,
  type ShortcutRow,
  type TypedRow,
} from '~/utils/help-shortcuts'

const crumbs = [
  { label: 'Help', icon: 'i-lucide-circle-help' },
  { label: 'Shortcuts' },
]

useHead({ title: 'Shortcuts' })

/** One table: its own heading, the caption a screen reader gets, and its rows. */
interface Table {
  title: string
  caption: string
  /** The header of the first column — the keys or the spelling. */
  column: string
  keyRows?: ShortcutRow[]
  codeRows?: TypedRow[]
  /** `kbd` where the reader types the spelling, `code` where a page stores it. */
  codeTag?: 'kbd' | 'code'
}

const sections: Array<{ title: string, intro: string, tables: Table[] }> = [
  {
    title: 'Keyboard shortcuts',
    intro: 'The modifier is ⌘ on a Mac and Ctrl everywhere else.',
    tables: [
      {
        title: 'Anywhere in the app',
        caption: 'The app’s own keyboard shortcuts and what they do.',
        column: 'Keys',
        keyRows: appShortcuts.map(row => ({ keys: shortcutKeys(row.id), what: row.what })),
      },
      {
        title: 'While editing a page',
        caption: 'The editor’s keyboard shortcuts and what they do.',
        column: 'Keys',
        keyRows: editorShortcuts,
      },
    ],
  },
  {
    title: 'Typed triggers',
    intro: 'Type these in the editor and a picker opens at the caret. Escape leaves what you typed as plain text.',
    tables: [
      {
        title: 'Pickers',
        caption: 'What each typed sequence opens in the editor.',
        column: 'Type',
        codeRows: typedTriggers,
        codeTag: 'kbd',
      },
    ],
  },
  {
    title: 'Markdown',
    intro: 'Markdown the editor converts into a block or a mark while you type it.',
    tables: [
      {
        title: 'Converted as you type',
        caption: 'Markdown the editor turns into a block or a mark while it is typed.',
        column: 'Type',
        codeRows: markdownRules,
        codeTag: 'kbd',
      },
    ],
  },
]
</script>

<template>
  <ChromeAppNavbar :crumbs="crumbs" />

  <ChromePageBody>
    <main
      id="main-content"
      tabindex="-1"
      class="mx-auto w-full max-w-[900px] px-4 py-6 focus:outline-none sm:px-6 sm:py-8"
    >
      <h1 class="mb-1 text-[24px] font-bold text-highlighted">
        Shortcuts
      </h1>
      <p class="mb-8 text-[13px] text-muted">
        Everything this app answers to: the keys, the sequences that open a picker while you type,
        and the markdown it converts as you type.
      </p>

      <section
        v-for="section in sections"
        :key="section.title"
        data-testid="help-section"
        class="mb-10 last:mb-0"
      >
        <h2 class="mb-1 text-[17px] font-semibold text-highlighted">
          {{ section.title }}
        </h2>
        <p class="mb-4 text-[13px] text-toned">
          {{ section.intro }}
        </p>

        <div v-for="table in section.tables" :key="table.title" class="mb-6 last:mb-0">
          <h3 class="mb-2 text-[13px] font-semibold uppercase tracking-wide text-dimmed">
            {{ table.title }}
          </h3>
          <!-- Wide rows scroll in their own box rather than widening the page.
               A scroller only a pointer can move is unreachable, so it takes
               focus and says what it holds. -->
          <div
            tabindex="0"
            role="region"
            :aria-label="table.title"
            class="overflow-x-auto rounded-[10px] shadow-[0_0_0_1px_var(--ui-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
          >
            <table class="w-full border-collapse text-left text-[13.5px]">
              <caption class="sr-only">
                {{ table.caption }}
              </caption>
              <thead>
                <tr class="border-b border-default bg-elevated/40 text-[12px] uppercase tracking-wide text-dimmed">
                  <th scope="col" class="w-[38%] px-4 py-2.5 font-semibold">
                    {{ table.column }}
                  </th>
                  <th scope="col" class="px-4 py-2.5 font-semibold">
                    What it does
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in table.keyRows ?? []"
                  :key="row.keys.join('-') + row.what"
                  class="border-b border-default last:border-0"
                >
                  <td class="px-4 py-2.5 align-top">
                    <!-- `+` between the caps, so the sequence reads as one
                         chord in speech as well as on screen. -->
                    <span class="inline-flex items-center gap-1 whitespace-nowrap">
                      <template v-for="(key, index) in row.keys" :key="key">
                        <span v-if="index > 0" class="text-[11px] text-dimmed">+</span>
                        <UKbd :value="key" />
                      </template>
                    </span>
                  </td>
                  <td class="px-4 py-2.5 align-top text-toned">
                    {{ row.what }}
                  </td>
                </tr>
                <tr
                  v-for="row in table.codeRows ?? []"
                  :key="row.code"
                  class="border-b border-default last:border-0"
                >
                  <td class="px-4 py-2.5 align-top">
                    <!-- A multi-line spelling (a component fence) keeps its
                         newlines, so it reads the way it is written. -->
                    <component
                      :is="table.codeTag ?? 'code'"
                      class="whitespace-pre font-mono text-[12.5px] text-highlighted"
                    >{{ row.code }}</component>
                  </td>
                  <td class="px-4 py-2.5 align-top text-toned">
                    {{ row.what }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  </ChromePageBody>
</template>
