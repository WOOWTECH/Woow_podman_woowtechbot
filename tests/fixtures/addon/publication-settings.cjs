'use strict';
function publicationSettings(options) {
  if (!options.published_url) return null;
  const published = new URL(options.published_url), app = new URL(options.public_url || 'http://invalid.invalid');
  if (published.protocol !== 'https:' || app.protocol !== 'https:') throw new Error('published_url and public_url must be HTTPS origins');
  if (published.hostname === app.hostname || published.hostname.endsWith('.' + app.hostname)) {
    throw new Error('published_url needs a separate DNS hostname');
  }
  return { origin: published.origin };
}
module.exports = { publicationSettings };
