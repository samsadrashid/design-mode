import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// The ensureLocalTransport block lives inside change-tracker.ts (same
// convention as change-source-location / file-route-regression). The full
// module touches browser.* at load, so tests slice the block, transpile it
// and bind its collaborators as function params.
function loadEnsure(
  browser: { runtime: { sendMessage: (msg: unknown) => Promise<unknown> } },
  connectToServer: (opts: unknown) => void,
  isConnected: () => boolean,
) {
  const source = readFileSync(new URL('./change-tracker.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function ensureLocalTransport');
  assert.ok(start >= 0, 'ensureLocalTransport block is missing from change-tracker.ts');
  const js = ts.transpileModule(source.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const grab = vm.runInThisContext(
    `(function (browser, connectToServer, isConnected) { ${js}; return { ensureLocalTransport }; })`,
  );
  return grab(browser, connectToServer, isConnected).ensureLocalTransport as
    (port: number, openWaitMs?: number) => Promise<boolean>;
}

test('returns true without a token probe while the local socket is already open', async () => {
  let probes = 0;
  const ensure = loadEnsure(
    { runtime: { sendMessage: async () => { probes += 1; return { token: 't' }; } } },
    () => assert.fail('connectToServer must not run while the socket is open'),
    () => true,
  );
  assert.equal(await ensure(9960), true);
  assert.equal(probes, 0);
});

test('reports the server unreachable without reopening when the token fetch fails', async () => {
  let reconfigured = 0;
  const ensure = loadEnsure(
    { runtime: { sendMessage: async () => ({ token: null }) } },
    () => { reconfigured += 1; },
    () => false,
  );
  assert.equal(await ensure(9960), false);
  assert.equal(reconfigured, 0);
});

test('reopens the transport and waits for the socket when the server answers late', async () => {
  let open = false;
  let reconfigured: unknown = null;
  const ensure = loadEnsure(
    { runtime: { sendMessage: async () => ({ token: 'tok' }) } },
    (opts) => {
      reconfigured = opts;
      setTimeout(() => { open = true; }, 40);
    },
    () => open,
  );
  assert.equal(await ensure(9960, 500), true);
  assert.deepEqual(reconfigured, { mode: 'local', port: 9960 });
});

test('gives up within the bounded wait when the socket never opens', async () => {
  const startedAt = Date.now();
  const ensure = loadEnsure(
    { runtime: { sendMessage: async () => ({ token: 'tok' }) } },
    () => {},
    () => false,
  );
  assert.equal(await ensure(9960, 60), false);
  assert.ok(Date.now() - startedAt < 2000, 'bounded wait must stay short');
});
