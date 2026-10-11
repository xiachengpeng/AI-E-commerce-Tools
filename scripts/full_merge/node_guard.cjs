// Test-only TCP/DNS restriction inherited by Node frontend tests and Playwright.
const net = require('node:net');
const dns = require('node:dns');
function local(host) { return host === undefined || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'; }
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = typeof first === 'object' ? first : null;
  const host = options ? options.host : (typeof normalized[1] === 'string' ? normalized[1] : undefined);
  if (!local(host)) throw new Error('isolated test network blocks external Node TCP');
  return connect.apply(this,args);
};
const lookup = dns.lookup;
dns.lookup = function(host,...args) {
  if (!local(host)) throw new Error('isolated test network blocks external Node DNS');
  return lookup.call(this,host,...args);
};
for (const name of Object.keys(dns).filter(name=>name.startsWith('resolve'))) {
  const original = dns[name];
  if (typeof original !== 'function') continue;
  dns[name] = function(host,...args) {
    if (!local(host)) throw new Error('isolated test network blocks external Node DNS');
    return original.call(this,host,...args);
  };
}
for (const name of Object.keys(dns.promises).filter(name=>name.startsWith('resolve') || name==='lookup')) {
  const original = dns.promises[name];
  dns.promises[name] = async function(host,...args) {
    if (!local(host)) throw new Error('isolated test network blocks external Node DNS');
    return original.call(this,host,...args);
  };
}
