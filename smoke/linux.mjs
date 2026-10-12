/**
 * OLP Linux live smoke (throwaway-runner friendly, repo-tracked seed).
 *
 * Exercises a RUNNING server end to end: auth, stats, files CRUD, node
 * site lifecycle, jail enforcement, settings, store/proxy/cron reads,
 * backup honesty, and a real pipe-shell WS round-trip.
 *
 * Usage (from the repo root, after install + build):
 *   PANEL_PORT=18098 PANEL_HOST=127.0.0.1 PANEL_ROOT=/tmp/olp-root \
 *     OLP_DATA_DIR=/tmp/olp-data node apps/server/dist/index.js &
 *   SMOKE_BASE=http://127.0.0.1:18098 \
 *     SMOKE_USER=<user> SMOKE_PASS=<pass> node smoke/linux.mjs
 *
 * Requires devDependency `ws` resolvable (plain `npm install`, not prune).
 * Hardcoded site port: SMOKE_SITE_PORT (default 18901).
 */
// OLP live smoke (throwaway, /tmp only): exercises a fresh install end to end.
import { execFileSync, execSync } from 'node:child_process';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:18094';
const BASE_HOST = new URL(BASE).hostname;
const BASE_PORT = new URL(BASE).port;
const results = [];
const check = (name, cond) => {
  results.push([cond ? 'PASS' : 'FAIL', name]);
  if (!cond) process.exitCode = 1;
};

const cj = '/tmp/olp-smoke-cj.txt';
const U = process.env.SMOKE_USER;
const P = process.env.SMOKE_PASS;
if (!U || !P) throw new Error('SMOKE_USER/SMOKE_PASS required');

const api = (method, path, body) => {
  const cmd = ['curl', '-s', '-b', cj, '-X', method, `${BASE}${path}`];
  if (body !== undefined) cmd.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  return execFileSync('curl', cmd.slice(1), { encoding: 'utf8' });
};
const json = (method, path, body) => JSON.parse(api(method, path, body) || 'null');

// login (fresh cookie jar)
execSync(`curl -s -c ${cj} -X POST ${BASE}/api/login -H 'Content-Type: application/json' -d '{"username":"${U}","password":"${P}"}'`, { encoding: 'utf8' });
check('login ok', JSON.parse(execSync(`curl -s -b ${cj} -X POST ${BASE}/api/login -H 'Content-Type: application/json' -d '{"username":"${U}","password":"${P}"}'`, { encoding: 'utf8' })).ok === true);

// stats + dashboard html + root redirect
check('stats has cpu/mem', (() => { const s = json('GET', '/api/stats'); return s.cpu && s.mem && typeof s.uptime === 'number'; })());
check('dashboard html', execSync(`curl -s -b ${cj} ${BASE}/dashboard`, { encoding: 'utf8' }).includes('<div id="app">'));
check('root redirect', execSync(`curl -s -o /dev/null -w '%{http_code}' -b ${cj} ${BASE}/`, { encoding: 'utf8' }) === '302');

// files CRUD
check('mkdir', json('POST', '/api/mkdir', { path: '', name: 'smoke' }).ok === true);
check('write', json('POST', '/api/write', { path: 'smoke', name: 'a.txt', content: 'smoke-data' }).ok === true);
check('read', json('POST', '/api/read', { path: 'smoke', name: 'a.txt' }).content === 'smoke-data');
check('list', json('GET', '/api/files?path=smoke').entries.some((e) => e.name === 'a.txt'));
check('rename', json('POST', '/api/rename', { path: 'smoke', from: 'a.txt', to: 'b.txt' }).ok === true);
check('delete', json('POST', '/api/delete', { path: 'smoke', name: 'b.txt' }).ok === true);

// node site: create, start, curl, stop, delete
const created = json('POST', '/api/sites', { name: 'smoke-node', type: 'node', path: 'smoke/srv.js', port: Number(process.env.SMOKE_SITE_PORT || 18901) });
check('site create rejects missing path', created.error === 'Path not found');
execSync(`curl -s -b ${cj} -X POST ${BASE}/api/write -H 'Content-Type: application/json' -d '{"path":"smoke","name":"srv.js","content":"require(\\"http\\").createServer((q,r)=>r.end(\\"SMOKE-NODE\\")).listen(process.env.PORT)"}'`);
const site = json('POST', '/api/sites', { name: 'smoke-node', type: 'node', path: 'smoke/srv.js', port: Number(process.env.SMOKE_SITE_PORT || 18901) });
check('site created', site.ok === true);
const sid = site.site.id;
check('site start', json('POST', `/api/sites/${sid}/start`).ok === true);
await new Promise((r) => setTimeout(r, 1500));
const sitePort = process.env.SMOKE_SITE_PORT || 18901;
check('site serves', execSync(`curl -s http://127.0.0.1:${sitePort}/`, { encoding: 'utf8' }) === 'SMOKE-NODE');
const logs = json('GET', `/api/sites/${sid}/logs`);
check('site logs live', logs.running === true);
check('site stop', json('POST', `/api/sites/${sid}/stop`).ok === true);
check('site delete', json('POST', `/api/sites/${sid}/delete`).ok === true);

// absolute paths outside the jail are always denied (resolve() semantics)
const evil = json('POST', '/api/sites', { name: 'evil', type: 'static', path: '/etc', port: 18903 });
check('static outside jail rejected', evil.error === 'Access outside working directory denied');

// settings + store + proxy + cron (no daemons here)
check('settings get', json('GET', '/api/settings').username === U);
check('settings save', json('POST', '/api/settings', { telegram: { enabled: false } }).ok === true);
check('store list has nginx', json('GET', '/api/install').items.some((i) => i.id === 'nginx'));
check('proxy list empty', Array.isArray(json('GET', '/api/nginx/proxies').proxies));
check('cron stopped here', json('GET', '/api/cron/status').running === false);
check('backup zip hint honest', json('POST', '/api/backups', { type: 'folder', name: 'x', source: 'smoke' }).error.includes('zip'));

// monitor wave 1 (read-only telemetry)
check('monitor summary 401', execSync(`curl -s -o /dev/null -w '%{http_code}' ${BASE}/api/monitor/summary`, { encoding: 'utf8' }) === '401');
const summary = json('GET', '/api/monitor/summary');
check('monitor summary shape', typeof summary.hostname === 'string' && typeof summary.arch === 'string' && summary.cpu && Array.isArray(summary.cpu.perCore) && summary.mem && summary.net && Array.isArray(summary.net.listeningPorts));
const procs = json('GET', '/api/monitor/processes?limit=5');
check('monitor processes shape', Array.isArray(procs.processes) && procs.processes.length > 0 && procs.processes.length <= 5 && typeof procs.processes[0].pid === 'number' && 'pm2' in procs && typeof procs.truncated === 'boolean');

// daemon status wave 3 (presence + best-effort control)
check('services 401', execSync(`curl -s -o /dev/null -w '%{http_code}' ${BASE}/api/services`, { encoding: 'utf8' }) === '401');
const services = json('GET', '/api/services');
check('services shape', Array.isArray(services.services) && services.services.length === 4 && services.services.every((s) => typeof s.id === 'string' && typeof s.active === 'boolean'));
const startAttempt = json('POST', '/api/services/postgres/start', {});
check('services start honest', startAttempt.ok === true || typeof startAttempt.error === 'string');
check('services unknown 404', json('POST', '/api/services/ntsysv/start', {}).error === 'Unknown service');

// monitor kill (privileged wave 2, same-box sleep victim)
check('monitor kill 401', execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST ${BASE}/api/monitor/processes/1/kill -H 'Content-Type: application/json' -d '{}'`, { encoding: 'utf8' }) === '401');
check('monitor kill denies init', json('POST', '/api/monitor/processes/1/kill', {}).error === 'Refusing to kill init');
const sleeper = execSync('sleep 300 >/dev/null 2>&1 & echo $!', { encoding: 'utf8' }).trim();
check('monitor kill TERM', json('POST', `/api/monitor/processes/${sleeper}/kill`, {}).ok === true);
let gone = false;
try {
  execSync(`kill -0 ${sleeper}`);
} catch {
  gone = true;
}
check('monitor kill gone', gone);
try {
  execSync(`kill -9 ${sleeper}`);
} catch {
  // already gone — the point
}

// terminal WS over real pipe shell
const { default: WebSocket } = await import('ws');
const cookie = execSync(`grep tpsid ${cj} | awk '{print $6"=" $7}' | tail -1`, { encoding: 'utf8' }).trim();
const ws = new WebSocket(`ws://${BASE_HOST}:${BASE_PORT}/term`, { headers: { cookie: `tpsid=${cookie.split('=')[1]}` } });
const got = await new Promise((resolve) => {
  let acc = '';
  const timer = setTimeout(() => resolve(acc), 8000);
  ws.on('message', (d) => {
    acc += d.toString();
    if (acc.includes('Terminal ready')) {
      ws.send('echo WS-SMOKE-123\n');
    }
    if (acc.includes('WS-SMOKE-123')) {
      clearTimeout(timer);
      resolve(acc);
    }
  });
  ws.on('error', () => {
    clearTimeout(timer);
    resolve(acc);
  });
});
check('terminal pipe echo', got.includes('WS-SMOKE-123'));
ws.terminate();

console.log(results.map(([s, n]) => `${s} ${n}`).join('\n'));
const fails = results.filter(([s]) => s === 'FAIL').length;
console.log(fails === 0 ? 'SMOKE ALL GREEN' : `SMOKE ${fails} FAILURES`);
