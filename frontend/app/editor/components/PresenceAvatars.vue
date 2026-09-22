<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed } from 'vue'
import { NuxtLink } from '#components'
import EditorPeerAvatar from './PeerAvatar.vue'
import { peerLabel, peerProfilePath, type PresencePeer } from '#shared/utils/presence'

/**
 * Collaborator presence strip: one avatar per connected peer (self included,
 * sorted first and ring-highlighted), filled with the peer's awareness color
 * so the strip matches the carets. Fed only by the mapped awareness states —
 * no coupling to any edit route's layout, so any editor chrome can mount it
 * as-is.
 *
 * Agent peers carry `via`; they render as "fago via claude" and wear a
 * robot badge instead of assuming every peer is a plain human.
 *
 * Initials name nobody, so every avatar carries its peer's full attribution as
 * an accessible name and takes focus — the tooltip opens on keyboard focus as
 * well as on hover, and a screen reader reads the peer rather than a letter.
 * A person's avatar is a link to their profile and needs no `tabindex`; an
 * agent has no profile, so it stays a labelled image that focus can still
 * reach. The avatar inside is decoration either way.
 */
const props = defineProps<{ peers: PresencePeer[] }>()

/** Slots the strip draws. Past it the last one becomes the `+N` overflow. */
const SLOTS = 5

/** `max` counts avatars, so the overflow chip has to be given its own slot. */
const max = computed(() => props.peers.length > SLOTS ? SLOTS - 1 : SLOTS)

/** The person looking at the strip, so their own agent is named as theirs. */
const viewerUid = computed(() => props.peers.find(peer => peer.isSelf && !peer.via)?.uid)

const strip = computed(() => props.peers.map(peer => ({
  peer,
  label: peerLabel(peer, viewerUid.value),
  href: peerProfilePath(peer),
})))
</script>

<template>
  <UAvatarGroup
    v-if="strip.length"
    :max="max"
    size="2xs"
    role="group"
    data-testid="presence-avatars"
    :aria-label="`${strip.length} connected`"
    :ui="{ base: 'ring-2 -me-px' }"
  >
    <UTooltip v-for="{ peer, label, href } in strip" :key="peer.clientId" :text="label">
      <!-- Self takes the group's own 2px ring in the brand colour, so marking
           it costs the peer beside it no width. `!` because the group's theme
           sets the ring colour on this same element. -->
      <component
        :is="href ? NuxtLink : 'span'"
        :to="href"
        :role="href ? undefined : 'img'"
        :tabindex="href ? undefined : 0"
        :aria-label="label"
        :data-presence-peer="peer.isSelf ? 'self' : 'peer'"
        class="inline-flex focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
        :class="peer.isSelf ? 'ring-primary!' : ''"
      >
        <EditorPeerAvatar :name="peer.name" :color="peer.color" :via="peer.via" />
      </component>
    </UTooltip>
  </UAvatarGroup>
</template>
