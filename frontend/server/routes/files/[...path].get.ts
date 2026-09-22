// Media-library dialog passthrough, static assets only — see server/utils/drupal-proxy.ts.
export default defineEventHandler(event => proxyStaticAsset(event))
