// Media-library dialog passthrough — see server/utils/drupal-proxy.ts.
export default defineEventHandler(event => proxyToDrupal(event))
