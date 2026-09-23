// Media-library dialog passthrough — see server/utils/drupal-proxy.ts.
// The dialog's Table display link, which core's media_library JS follows with
// Drupal.ajax; the path is the media_library view's own.
export default defineEventHandler(event => proxyToDrupal(event))
