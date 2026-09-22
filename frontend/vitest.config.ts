import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Two projects split the suites by what they need to run:
//
//  * `unit` — pure unit + round-trip suites. No stack, no network. This is the
//    default (`npm test`) and the CI `vitest` stage, which runs before the site
//    is deployed.
//  * `integration` — the `*.integration.test.ts` suites that drive the running
//    stack (Drupal + frontend dev server over real websockets). They need the
//    deployed site, so CI runs this project in its own stage after deploy and
//    never mixes it into `unit`.
//
// The split lives here, in project membership, not in the runner: CI triggers a
// project by name (`vitest run --project integration`), so no suite is named or
// env-gated in the Jenkinsfile. A project whose glob matches nothing exits
// non-zero, so a mis-wired stage fails loudly instead of passing empty.
export default defineConfig({
  // The vue plugin lets tests import the real editor nodes (Callout /
  // Infobox), which pull in their .vue NodeViews.
  plugins: [vue()],
  test: {
    environment: 'node',
    // Both projects inherit this. On CI the suites share an executor with the
    // deploy and the other stages, and the 5s default flakes under that
    // contention.
    ...(process.env.CI ? { testTimeout: 15_000 } : {}),
    // The round-trip suites need DOM globals (happy-dom) but read their
    // fixtures from disk. Vite's client resolver replaces `node:*` builtins
    // with a browser stub, so transform them as SSR modules instead.
    testTransformMode: { ssr: ['**/test/roundtrip/**'] },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['server/**/*.test.ts', 'app/**/*.test.ts', 'shared/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
  resolve: {
    alias: [
      // Exact-match only: a bare `vue: …` entry also rewrites subpaths like
      // `vue/server-renderer`, which the SSR transform needs.
      { find: /^vue$/, replacement: 'vue/dist/vue.runtime.esm-bundler.js' },
      // Nuxt's rootDir alias — composables reach server-side types through it.
      { find: '~~', replacement: fileURLToPath(new URL('.', import.meta.url)) },
      // Nuxt's srcDir alias. Longer prefixes are matched first above, so `~~`
      // is never swallowed by this one.
      { find: '~', replacement: fileURLToPath(new URL('./app', import.meta.url)) },
      // Nuxt's shared-layer alias — code both the app and the Nitro server
      // import (the awareness `user` shape, the collab auth reasons).
      { find: '#shared', replacement: fileURLToPath(new URL('./shared', import.meta.url)) },
      // Nuxt generates `#components` from the auto-import scan; the suites run
      // without that, so components imported from it come from a stub.
      { find: '#components', replacement: fileURLToPath(new URL('./test/stubs/nuxt-components.ts', import.meta.url)) },
    ],
  },
})
