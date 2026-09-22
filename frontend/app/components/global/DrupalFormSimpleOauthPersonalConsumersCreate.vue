<script setup lang="ts">
/**
 * The "Agents & API clients" page, as this app renders it.
 *
 * A `drupal-form-*` custom element like any other: the element is Drupal's own
 * create form — CSRF token, field and button arrive in the default slot and
 * post straight back, so provisioning works with JavaScript off — and the props
 * are the facts `openkb_agent` put there. The clients are the same rows the
 * stock Drupal page lists, claimed connect-by-URL clients included; nothing
 * about that listing is decided here.
 *
 * The two ways in sit side by side because they are alternatives, not steps:
 * a client that can open a browser registers itself against the MCP URL, and
 * one that cannot gets a token provisioned for it. What either produces is the
 * table underneath, which is the account's standing record of who may act as
 * it.
 */
import { claudeCodeConnectCommand, mcpEndpoint } from '#shared/utils/agent-connect'
import { backendUrl } from '#shared/utils/user'
import { connectedCell, lastUsedCell, type ApiClient } from '~/utils/api-clients'

/** The grant the agent exchanges the credentials with, explained. */
const GRANT_DOCS = 'https://oauth.net/2/grant-types/client-credentials/'

/** The client this response provisioned — the only render its secret gets. */
interface CreatedClient {
  label: string
  clientId: string
  secret: string
}

const props = defineProps<{
  /** The account these clients act as, which is whoever is signed in. */
  account?: string
  /** The account's clients, revoked ones included. */
  clients?: ApiClient[]
  /** Set when this response is the answer to a create submit. */
  createdClient?: CreatedClient
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  method?: string
}>()

const { title, messages } = useKbCePage()
const { copy } = useCopyText()

const clients = computed(() => props.clients ?? [])

const createdFields = computed(() => props.createdClient
  ? [
      { label: 'Client ID', value: props.createdClient.clientId, testId: 'created-client-id' },
      { label: 'Client secret', value: props.createdClient.secret, testId: 'created-client-secret' },
    ]
  : [])

/** The MCP endpoint, on the origin the reader is already on. */
const origin = useRequestURL().origin
const mcpUrl = mcpEndpoint(origin)
const claudeCodeCommand = claudeCodeConnectCommand(origin)

/** Where the agent exchanges the credentials below for a token. */
const tokenUrl = backendUrl(useRuntimeConfig().public.drupalBaseUrl as string | undefined, '/oauth/token')

const action = useRoute().fullPath
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Breadcrumbs, not the navbar's own title: `UDashboardNavbar` renders
         that as an `h1`, and the page's heading belongs in its `main`. -->
    <ChromeAppNavbar :crumbs="[{ label: account ?? 'Account', icon: 'i-lucide-circle-user' }, { label: title }]" />
    <ChromePageBody>
      <main id="main-content" tabindex="-1" class="mx-auto w-full max-w-[1200px] px-4 py-6 focus:outline-none sm:px-7 sm:py-8">
        <DrupalCeMessages :messages="messages" class="mb-6" />

        <h1 class="mb-2 text-[26px] font-bold leading-[1.15] tracking-tight text-highlighted sm:text-[30px]">
          {{ title }}
        </h1>
        <p class="mb-8 max-w-[70ch] text-[15px] leading-relaxed text-muted">
          An agent connected here acts as
          <strong class="text-highlighted">{{ account ?? 'you' }}</strong> — anything it
          writes is recorded under your name and waits for a human to publish it.
        </p>

        <!-- The one render the secret gets: it arrives as a prop of this
             response, not in Drupal's messages, which the app's other Drupal
             calls can drain before this page renders. -->
        <section
          v-if="createdClient"
          aria-labelledby="created-heading"
          data-testid="created-client"
          class="mb-8 rounded-lg border border-warning/50 bg-warning/5 p-4 sm:p-5"
        >
          <h2 id="created-heading" class="mb-1 text-[17px] font-semibold tracking-tight text-highlighted">
            Copy the secret now — it is shown once
          </h2>
          <p class="mb-4 max-w-[70ch] text-[14px] leading-relaxed text-muted">
            <strong class="text-highlighted">{{ createdClient.label }}</strong> is
            provisioned. Only the hash is kept, so no later page can show the secret again.
          </p>
          <dl class="grid gap-3 sm:grid-cols-2">
            <div v-for="field in createdFields" :key="field.label" class="min-w-0">
              <dt class="mb-1 text-[13px] font-semibold text-highlighted">
                {{ field.label }}
              </dt>
              <dd class="flex items-center gap-2 rounded-md border border-default bg-default p-2">
                <code
                  :data-testid="field.testId"
                  class="min-w-0 flex-1 break-all px-1 font-mono text-[13px] leading-relaxed text-highlighted"
                >{{ field.value }}</code>
                <UButton
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-copy"
                  :aria-label="`Copy the ${field.label.toLowerCase()}`"
                  class="min-h-11 min-w-11 shrink-0 justify-center"
                  @click="copy(field.value, field.label)"
                />
              </dd>
            </div>
          </dl>
          <p class="mt-4 max-w-[70ch] text-[13px] leading-relaxed text-muted">
            Exchange them at <code class="font-mono text-highlighted">{{ tokenUrl }}</code>
            (<a
              :href="GRANT_DOCS"
              target="_blank"
              rel="noopener"
              class="underline underline-offset-2 hover:text-highlighted"
            >client-credentials grant</a>) for a short-lived token, and send it as
            <code class="font-mono text-highlighted">Authorization: Bearer &lt;token&gt;</code> to
            <code class="font-mono text-highlighted">{{ mcpUrl }}</code>.
          </p>
        </section>

        <div class="mb-8 grid items-start gap-5 xl:grid-cols-2 xl:gap-6">
          <section
            aria-labelledby="connect-heading"
            class="rounded-lg border border-default p-4 sm:p-5"
          >
            <h2 id="connect-heading" class="mb-1 text-[17px] font-semibold tracking-tight text-highlighted">
              Connect an agent (MCP)
            </h2>
            <p class="mb-4 max-w-[70ch] text-[14px] leading-relaxed text-muted">
              Point an MCP client at this URL. The client registers itself, you approve
              it in the browser once, and it appears in the table below — where you can
              revoke it at any time.
            </p>

            <div class="mb-4 flex items-center gap-2 rounded-md border border-default bg-elevated/40 p-2">
              <!-- Wrapped, not scrolled: the whole URL has to be readable to be
                   checked against what a client was pointed at. -->
              <code
                data-testid="mcp-url"
                class="min-w-0 flex-1 break-all px-1 font-mono text-[13px] leading-relaxed text-highlighted"
              >{{ mcpUrl }}</code>
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                icon="i-lucide-copy"
                :aria-label="`Copy the MCP URL ${mcpUrl}`"
                class="min-h-11 min-w-11 shrink-0 justify-center"
                @click="copy(mcpUrl, 'MCP URL')"
              />
            </div>

            <dl class="mb-4 flex flex-col gap-3">
              <div>
                <dt class="mb-1 text-[13px] font-semibold text-highlighted">
                  Claude.ai
                </dt>
                <dd class="text-[14px] leading-relaxed text-muted">
                  Add a custom connector and paste the URL above. That is the whole setup.
                </dd>
              </div>
              <div>
                <dt class="mb-1 text-[13px] font-semibold text-highlighted">
                  Claude Code
                </dt>
                <dd class="flex items-center gap-2 rounded-md border border-default bg-elevated/40 p-2">
                  <code
                    data-testid="mcp-claude-code"
                    class="min-w-0 flex-1 break-all px-1 font-mono text-[13px] leading-relaxed text-highlighted"
                  >{{ claudeCodeCommand }}</code>
                  <UButton
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-copy"
                    aria-label="Copy the Claude Code command"
                    class="min-h-11 min-w-11 shrink-0 justify-center"
                    @click="copy(claudeCodeCommand, 'Command')"
                  />
                </dd>
              </div>
            </dl>

            <p class="max-w-[70ch] text-[13px] leading-relaxed text-dimmed">
              No browser and no person in the loop — a headless agent, a cron job, a
              script? That client cannot log in, so provision a token for it instead.
            </p>
          </section>

          <section
            aria-labelledby="create-heading"
            class="rounded-lg border border-default p-4 sm:p-5"
          >
            <h2 id="create-heading" class="mb-1 text-[17px] font-semibold tracking-tight text-highlighted">
              Provision a token
            </h2>
            <p class="mb-4 max-w-[70ch] text-[14px] leading-relaxed text-muted">
              For an agent that cannot open a browser. The client id and secret are
              shown once, right here, the moment you create it.
            </p>
            <form
              v-bind="attributes ?? {}"
              :method="method ?? 'post'"
              :action="action"
              class="drupal-form"
            >
              <slot />
            </form>
          </section>
        </div>

        <section aria-labelledby="clients-heading">
          <h2 id="clients-heading" class="mb-3 text-[17px] font-semibold tracking-tight text-highlighted">
            Your clients
          </h2>
          <!-- Focusable and named: the table keeps its columns aligned by
               scrolling rather than reflowing, and a scroll container a keyboard
               cannot reach is unusable. -->
          <div
            v-if="clients.length"
            data-testid="api-clients"
            role="region"
            aria-labelledby="clients-heading"
            tabindex="0"
            class="overflow-x-auto rounded-lg border border-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
          >
            <table class="w-full min-w-[52rem] border-collapse text-left text-[14px]">
              <caption class="sr-only">
                The clients that may act as {{ account ?? 'you' }}, revoked ones included.
              </caption>
              <thead>
                <tr class="border-b border-default bg-elevated/40 text-[12px] uppercase tracking-wide text-dimmed">
                  <th scope="col" class="px-4 py-2.5 font-semibold">
                    Client
                  </th>
                  <th scope="col" class="px-4 py-2.5 font-semibold">
                    Status
                  </th>
                  <th scope="col" class="px-4 py-2.5 font-semibold">
                    Client ID
                  </th>
                  <th scope="col" class="px-4 py-2.5 font-semibold">
                    Connected
                  </th>
                  <th scope="col" class="px-4 py-2.5 font-semibold">
                    Last used
                  </th>
                  <th scope="col" class="px-4 py-2.5 text-right font-semibold">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="client in clients"
                  :key="client.clientId"
                  data-testid="api-client"
                  class="border-b border-default last:border-b-0"
                >
                  <th scope="row" class="min-w-[11rem] px-4 py-3 text-left align-middle font-semibold text-highlighted">
                    {{ client.label }}
                  </th>
                  <td class="px-4 py-3 align-middle">
                    <UBadge
                      :color="client.revoked ? 'neutral' : 'success'"
                      variant="soft"
                      size="sm"
                      :data-status="client.revoked ? 'revoked' : 'active'"
                    >
                      {{ client.revoked ? 'Revoked' : 'Active' }}
                    </UBadge>
                  </td>
                  <td class="px-4 py-3 align-middle">
                    <code class="whitespace-nowrap font-mono text-[12px] text-dimmed">{{ client.clientId }}</code>
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 align-middle text-muted">
                    {{ connectedCell(client.created) }}
                  </td>
                  <!-- To the hour, which is the resolution Drupal records. -->
                  <td class="whitespace-nowrap px-4 py-3 align-middle text-muted">
                    {{ lastUsedCell(client.lastUsed) }}
                  </td>
                  <td class="px-4 py-3 text-right align-middle">
                    <UButton
                      v-if="client.revokeUrl"
                      :to="client.revokeUrl"
                      external
                      data-testid="revoke-client"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      icon="i-lucide-ban"
                      class="min-h-11"
                      :aria-label="`Revoke ${client.label}`"
                    >
                      Revoke
                    </UButton>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-[14px] text-muted">
            No clients yet. Connect one above, or provision a token.
          </p>
        </section>
      </main>
    </ChromePageBody>
  </div>
</template>
