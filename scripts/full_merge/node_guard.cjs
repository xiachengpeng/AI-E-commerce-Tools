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

// Native children are denied by default. The sole required native exception is
// Playwright's installed Chromium, with the test launch flags and temporary HOME.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function denied() { throw new Error('isolated test subprocess blocks unguarded Node children'); }
function guardedOptions(file,args,options={}) {
  if (options.shell || options.execPath) denied();
  let binary,cache;
  try { binary=fs.realpathSync(file);cache=fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH); } catch { denied(); }
  const allowedNames=new Set(['chrome-headless-shell','Chromium','chrome']);
  if (!binary.startsWith(cache+path.sep) || !allowedNames.has(path.basename(binary))) denied();
  if (!args.includes('--remote-debugging-pipe') || !args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1')) denied();
  const profile=args.find(arg=>arg.startsWith('--user-data-dir='));
  if (!profile || !path.resolve(profile.slice('--user-data-dir='.length)).startsWith(path.resolve(process.env.FULL_MERGE_SANDBOX)+path.sep)) denied();
  const env={...(options.env || process.env)};
  for(const key of ['NODE_OPTIONS','FULL_MERGE_SANDBOX','PLAYWRIGHT_BROWSERS_PATH','PYTHONPATH','HOME','TMPDIR']) {
    if(process.env[key] !== undefined) env[key]=process.env[key];
  }
  return {...options,env};
}
const spawn=cp.spawn;
cp.spawn=function(file,args=[],options={}) { return spawn.call(this,file,args,guardedOptions(file,args,options)); };
const spawnSync=cp.spawnSync;
cp.spawnSync=function(file,args=[],options={}) { return spawnSync.call(this,file,args,guardedOptions(file,args,options)); };
const nativeSpawn=cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn=function(options) {
  const args=options.args?.slice(1) || [];
  const guarded=guardedOptions(options.file,args,options);
  const envPairs=(options.envPairs || []).filter(value=>!['NODE_OPTIONS','FULL_MERGE_SANDBOX','PLAYWRIGHT_BROWSERS_PATH','PYTHONPATH','HOME','TMPDIR'].some(key=>value.startsWith(key+'=')));
  for(const key of ['NODE_OPTIONS','FULL_MERGE_SANDBOX','PLAYWRIGHT_BROWSERS_PATH','PYTHONPATH','HOME','TMPDIR']) {
    if(guarded.env[key] !== undefined) envPairs.push(key+'='+guarded.env[key]);
  }
  return nativeSpawn.call(this,{...options,envPairs});
};
for(const name of ['exec','execSync','execFile','execFileSync','fork']) cp[name]=denied;
require('node:module').syncBuiltinESMExports();
