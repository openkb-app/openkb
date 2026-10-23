/**
 * What the `#okb-fences*` modules resolve to under vitest: the app's own
 * fences, as `modules/fences.ts` would collect them, plus the test-only
 * `stub` fence. Generic fence tests use `stub`; a fence's own tests live in
 * its directory.
 */
import { defineAsyncComponent } from 'vue'
import mermaid from '../../fences/mermaid/fence'
import stub from './fences/stub/fence'

export const fences = [{ ...mermaid, language: 'mermaid' }, { ...stub, language: 'stub' }]

export const fenceComponents = {
  mermaid: defineAsyncComponent(() => import('../../fences/mermaid/Fence.vue')),
  stub: defineAsyncComponent(() => import('./fences/stub/Fence.vue')),
}

export const fenceServers = {
  mermaid: () => import('../../fences/mermaid/server'),
  stub: () => import('./fences/stub/server'),
}
