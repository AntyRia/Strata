// /api is reachable from a page on any localhost port, and the chat routes ask for no token: a dev server, a notebook or any
// other local page could set a chat to Bypass and stream a turn. A PACKAGED app therefore accepts only its own origin (this
// host's port); a development run keeps the wider rule, because `npm run dev:web` serves the UI from Vite on another port.
// Run on a real host (no model needed: /api/chat/mode answers "no session yet").
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

async function startHost({ packaged }) {
  const home = await mkdtemp(join(tmpdir(), 'strata-host-apiorigin-'));
  const port = await freePort();
  const env = {
    ...process.env, STRATA_HOME: home, STRATA_MODELS_DIR: join(home, 'models'), STRATA_PORT: String(port),
    STRATA_SHARE_PORT: String(await freePort()), STRATA_TUNNEL_PORT: String(await freePort()), STRATA_REAL_ENGINE: '1',
    STRATA_SETTINGS_FILE: join(home, 'app-settings.json'), STRATA_COMPONENTS_DIR: join(home, 'components'),
    LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'), XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_STATE_HOME: join(home, 'xdg-state'), XDG_CONFIG_HOME: join(home, 'xdg-config'),
  };
  if (packaged) env.STRATA_PACKAGED = '1'; else delete env.STRATA_PACKAGED;
  const host = spawn(process.execPath, ['server/index.mjs'], { cwd: root, stdio: 'ignore', env });
  const exit = new Promise(r => host.once('exit', (code, signal) => r({ code, signal })));
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await delay(100); } }
  assert.ok(up, 'host started');
  return { port, done: async () => { host.kill('SIGKILL'); await exit; await rm(home, { recursive: true, force: true }).catch(() => {}); } };
}

/** One HTTP/1.1 request on its own socket, headers exactly as given. Resolves { status, body }. */
function request(port, method, path, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const lines = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), ...(body ? ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`] : [])];
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`));
    socket.on('data', c => { data += c; });
    socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0), body: data.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    socket.on('error', reject);
  });
}

const mode = JSON.stringify({ sessionId: 'probe', mode: 'bypass' });

test('packaged: only this host\'s own page may set a chat mode (any other localhost port is refused)', async () => {
  const h = await startHost({ packaged: true });
  try {
    const other = `http://localhost:${await freePort()}`;
    const fromOther = await request(h.port, 'POST', '/api/chat/mode', { Origin: other }, mode);
    assert.equal(fromOther.status, 403, `a page on ${other} must not reach /api (got ${fromOther.status} ${fromOther.body.slice(0, 80)})`);
    const fromOtherVite = await request(h.port, 'POST', '/api/chat/mode', { Origin: `http://127.0.0.1:${await freePort()}` }, mode);
    assert.equal(fromOtherVite.status, 403);
    const fromForeign = await request(h.port, 'POST', '/api/chat/mode', { Origin: 'https://evil.example' }, mode);
    assert.equal(fromForeign.status, 403);
    const own = await request(h.port, 'POST', '/api/chat/mode', { Origin: `http://127.0.0.1:${h.port}` }, mode);
    assert.notEqual(own.status, 403, 'the app\'s own page still works');
    assert.equal(own.status, 200, own.body.slice(0, 120));
    const noOrigin = await request(h.port, 'POST', '/api/chat/mode', {}, mode);
    assert.notEqual(noOrigin.status, 403, 'curl, SDKs and editors name no Origin and are unchanged');
  } finally { await h.done(); }
});

test('a development run keeps the wider rule: Vite on another localhost port may use /api', async () => {
  const h = await startHost({ packaged: false });
  try {
    const vite = await request(h.port, 'POST', '/api/chat/mode', { Origin: `http://localhost:${await freePort()}` }, mode);
    assert.notEqual(vite.status, 403, `npm run dev:web must keep working (got ${vite.status} ${vite.body.slice(0, 80)})`);
    const foreign = await request(h.port, 'POST', '/api/chat/mode', { Origin: 'https://evil.example' }, mode);
    assert.equal(foreign.status, 403, 'another site is still refused in development');
  } finally { await h.done(); }
});
