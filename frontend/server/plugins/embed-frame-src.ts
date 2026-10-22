import { defineNitroPlugin } from 'nitropack/runtime'
import { embedFrameSrcPolicy } from '../utils/files'

/** Sends `embedFrameSrcPolicy()` on every page Nuxt renders. */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:response', (response) => {
    response.headers = { ...response.headers, 'content-security-policy': embedFrameSrcPolicy(import.meta.dev) }
  })
})
