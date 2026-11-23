'use strict';
function odooMcpSettings(options) {
  for (const key of ['apporo_odoo_mcp_url', 'woow_prod_odoo_mcp_url']) {
    if (options[key] && !/^https:\/\/[^/]+\/private_[\w-]+\/mcp$/.test(options[key])) throw new Error(`${key}: use the dedicated endpoint`);
  }
  return { gateways: [], managed: [] };
}
module.exports = { odooMcpSettings };
