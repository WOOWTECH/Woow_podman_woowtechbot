#!/usr/bin/env node
'use strict';
// healthcheck.cjs: the container health check. The same probe as the PaaS chart
// (GET http://127.0.0.1:8799/api/health inside the pod), with Node instead of curl so it does not
// depend on what else the image carries.
const http = require('node:http');
const req = http.get({ host: '127.0.0.1', port: 8799, path: '/api/health', timeout: 4000 }, res => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
