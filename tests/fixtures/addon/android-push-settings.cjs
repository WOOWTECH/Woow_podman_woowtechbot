'use strict';

function androidPushSettings(options) {
  if (options.android_push_enabled !== true) return { enabled: false, env: { WOOWTECH_ANDROID_PUSH: '0' } };
  const credential = options.android_push_credential;
  if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(credential)) {
    throw new Error('Android push requires a dedicated base64url relay credential');
  }
  let url;
  try { url = new URL(options.android_push_relay_url); }
  catch { throw new Error('Android push requires an HTTPS relay URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/v1/android-push') {
    throw new Error('Android push relay must be an HTTPS /v1/android-push URL without credentials or query');
  }
  return { enabled: true, env: {
    WOOWTECH_ANDROID_PUSH: '1',
    WOOWTECH_ANDROID_PUSH_RELAY: url.href,
    WOOWTECH_ANDROID_PUSH_CREDENTIAL: credential,
  } };
}

module.exports = { androidPushSettings };
