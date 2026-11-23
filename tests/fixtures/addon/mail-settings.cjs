'use strict';
function mailSettings(options) {
  const url = options.signin_relay_url || '', token = options.signin_relay_token || '';
  if (Boolean(url) !== Boolean(token)) throw new Error('signin relay: supply both the service URL and its dedicated token');
  if (url && !url.endsWith('/api/woowtechbot/signin-mail')) throw new Error('signin relay: use the HTTPS sign-in mail endpoint');
  return { enabled: Boolean(url), env: {} };
}
module.exports = { mailSettings };
