'use strict';
function hostingSettings(options, tokenFactory) {
  if (!options.public_url) return { enabled: false };
  if (tokenFactory().length < 32) throw new Error('weak token');
  return { enabled: options.public_url.startsWith('https:') };
}
module.exports = { hostingSettings };
