const drupalBaseUrl = process.env.NUXT_PUBLIC_DRUPAL_CE_DRUPAL_BASE_URL
  || process.env.BACKEND_URL
  || 'http://drupal:8080'

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', 'nuxtjs-drupal-ce'],

  // Brand tokens are defined for both schemes (app/assets/css/main.css), so
  // the scheme follows `prefers-color-scheme` and `classSuffix: ''` puts the
  // plain `.dark` class the token block is keyed on onto <html>.
  colorMode: {
    preference: 'system',
    fallback: 'light',
    classSuffix: '',
  },

  ui: {
    // UContentToc + UContentSearch live under content/* — Nuxt UI skips
    // auto-registering them unless @nuxt/content is installed or this
    // flag is set explicitly.
    content: true,
  },

  icon: {
    // SVG over the default CSS masks: no flash on first paint.
    mode: 'svg',
    // Every collection this app names is installed (`@iconify-json/*` in
    // package.json), so @nuxt/icon serves them from its server bundle and no
    // icon request leaves the site. Without this an unknown name is fetched
    // from api.iconify.design instead of being reported.
    fallbackToApi: false,
  },

  // app/editor/components/* are auto-imported alongside the default
  // app/components/* tree, prefixed `Editor` (so LiveSyncChip.vue
  // resolves as <EditorLiveSyncChip />). Keeps everything editor-related
  // under app/editor/ without losing Nuxt's component auto-import.
  components: [
    { path: '~/components/chrome', prefix: 'Chrome' },
    { path: '~/components/view', prefix: 'View' },
    { path: '~/components/spaces', prefix: 'Space' },
    { path: '~/components/kb', prefix: 'Kb' },
    { path: '~/components', pathPrefix: false },
    { path: '~/components/global', global: true, pathPrefix: false },
    { path: '~/editor/components', prefix: 'Editor' },
  ],

  // Manrope and JetBrains Mono are served from `public/fonts/`; `main.css`
  // declares both faces itself, so there is no font package and no CDN.
  css: [
    '~/assets/css/main.css',
  ],

  // `@nuxt/fonts` (a Nuxt UI dependency) auto-provisions every family it finds
  // named in CSS. `main.css` already declares both faces against files in
  // `public/fonts/`, so the only provider left standing is `local`, which
  // serves nothing the app is not already shipping.
  fonts: {
    provider: 'local',
  },

  app: {
    head: {
      // Assistive technology picks the speech synthesiser from `lang`. The
      // window/tab title is how a page is identified in a tab list or a
      // screen-reader's window switcher; app.vue holds its template, which a
      // nuxt.config head cannot (functions do not survive serialisation).
      htmlAttrs: { lang: 'en' },
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
      ],
      meta: [
        // The mark's slate indigo, so a mobile browser's chrome matches the app.
        { name: 'theme-color', content: '#4c5a9e' },
      ],
    },
  },

  drupalCe: {
    drupalBaseUrl,
    // The CE-API ships in explicit format: {element, props, slots}.
    customElementJsonFormat: 'explicit',
    // Both left at the module defaults, because the user menu is Drupal's
    // `account` menu rather than a menu this app writes: `menuEndpoint`
    // reaches rest_menu_items (lupus_decoupled_menu), and the session cookie
    // has to ride along on the SSR fetches. The account menu is per-session —
    // it says "Log in" or "Log out" depending on who is asking, and the logout
    // item carries that session's CSRF token — and the logout link itself is
    // an ordinary page fetch through this proxy, which only ends a session
    // Drupal can see. Anonymous CE reads would answer both with the signed-out
    // menu and a 403.
    // The media-library dialog's form submits (selection, upload), views AJAX
    // and its Grid/Table display links are urlencoded/multipart POSTs served
    // by our own Drupal proxy (server/utils/drupal-proxy.ts) — keep the
    // module's global form handler off them. Exact path match, query string
    // ignored, so the display links name the one media type the editor's
    // opener allows.
    disableFormHandler: [
      '/media-library',
      '/views/ajax',
      '/admin/content/media-widget/image',
      '/admin/content/media-widget-table/image',
    ],
    // The Canvas page builder is not part of this app, so the component
    // preview endpoint and its component-index build step are off.
    enableComponentPreview: false,
  },

  runtimeConfig: {
    drupalBaseUrl,
    hocuspocusPath: '/collaboration',
    public: {
      drupalBaseUrl,
      // ai_assistant config entity id sent as `agentId` to /vercel-ai/chat.
      // Overridable via NUXT_PUBLIC_CHAT_AGENT_ID.
      chatAgentId: 'openkb',
    },
  },

  nitro: {
    experimental: {
      websocket: true,
    },
    imports: {
      // Nitro auto-imports every export under server/utils. The MCP suites'
      // harness exports vitest mocks named after the functions it stands in
      // for, so it stays out of the scan.
      dirs: ['!**/*.test-harness.ts'],
    },
  },

  hooks: {
    // Replace nuxtjs-drupal-ce's default /api/drupal-ce passthrough with
    // our own (server/api/drupal-ce/[...path].get.ts) so kb_page responses
    // get the comark tree spliced onto content.props.bodyTree. The composable
    // /api/drupal-ce as its baseURL — we just own that route now.
    'nitro:config'(nitroConfig) {
      nitroConfig.handlers = (nitroConfig.handlers ?? []).filter((h) => {
        const handler = String((h as { handler?: string }).handler ?? '')
        return !(handler.includes('nuxtjs-drupal-ce') && handler.includes('drupalCe'))
      })
    },
  },

  // Force Vite to pre-bundle prosemirror packages through @nuxt/ui's tree so
  // they're loaded as a single instance. Without this, prosemirror-state
  // ships its module-level `keys` registry twice and any unkeyed plugin
  // (e.g. inputRulesPlugin in @tiptap/core) collides on "plugin$".
  // Documented in https://ui.nuxt.com/docs/components/editor.
  vite: {
    // Allow serving the dev server on the localdev wildcard (any *.localdev.space
    // host) and the in-network `frontend` service name (the e2e MCP client reaches
    // the app directly there, bypassing the review-app proxy — see
    // tests/playwright/tests/mcp-client.spec.ts).
    server: {
      allowedHosts: ['.localdev.space', 'frontend'],
    },
    optimizeDeps: {
      include: [
        '@nuxt/ui > prosemirror-state',
        '@nuxt/ui > prosemirror-transform',
        '@nuxt/ui > prosemirror-model',
        '@nuxt/ui > prosemirror-view',
        '@nuxt/ui > prosemirror-gapcursor',
        // Nuxt UI's UEditor reaches prosemirror-tables through
        // @tiptap/vue-3/menus > @tiptap/extension-bubble-menu >
        // @tiptap/pm/tables. That subpath is not an optimizer entry on its
        // own, so Vite serves prosemirror-tables raw there, while our
        // app/editor/extensions.ts import of @tiptap/extension-table gets it
        // inlined into a pre-bundled chunk. Two CellSelection classes, one
        // shared prosemirror-state registry (see above) — the second
        // Selection.jsonID('cell', …) throws "Duplicate use of selection
        // JSON ID cell" and the editor route 500s. Listing the subpath pulls
        // both into the same optimizer run, where esbuild hoists
        // prosemirror-tables into one shared chunk.
        '@tiptap/vue-3/menus',
      ],
    },
  },

  typescript: {
    strict: true,
  },
})
