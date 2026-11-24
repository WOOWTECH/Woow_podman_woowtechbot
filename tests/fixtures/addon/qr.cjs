'use strict';
// The real qr.cjs refuses values over 2048 characters; this double does the same.
module.exports = {
  qrSvg: value => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid QR value');
    return `<svg data-len="${value.length}"/>`;
  },
};
