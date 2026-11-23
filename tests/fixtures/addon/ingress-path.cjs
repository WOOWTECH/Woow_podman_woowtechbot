'use strict';
function ingressOrigin(value) {
  if (typeof value !== 'string' || value === '') throw new Error('ingress_origin is required');
  const url = new URL(value);
  if (value !== url.origin) throw new Error('ingress_origin must be an exact http(s) origin');
  return { origin: url.origin, host: url.host, scheme: url.protocol.slice(0, -1) };
}
module.exports = { ingressOrigin };
