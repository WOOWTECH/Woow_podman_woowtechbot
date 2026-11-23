'use strict';
// A 3x3 checkerboard instead of a real QR code: enough to test the terminal rendering.
function QRCode() { this.data = ''; }
QRCode.prototype.addData = function (value) { this.data = value; };
QRCode.prototype.make = function () {};
QRCode.prototype.getModuleCount = function () { return 3; };
QRCode.prototype.isDark = function (y, x) { return (x + y) % 2 === 0; };
module.exports = QRCode;
