import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createCommentStore } from './comment-store';
import { createSessionStore } from './session-store';
import { isAnalyticsSender } from '../platform/analytics';

const compiled = ts.transpileModule(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Same harness shape as site-route-background.test.ts, with the tab-message
// forward behavior injectable so the pinned tab can simulate a missing
// content script.
function harness(forward: (tabId: number, message: any) => Promise<any>) {
  let listener: (message: any, sender: any, respond: (value: any) => void) => boolean;
  const event = { addListener() {} };
  const tabs = new Map<number, { url?: string }>([[7, { url: 'https://example.test/current' }]]);
  const records: Record<string, unknown> = {};
  const storage = {
    get: async () => structuredClone(records),
    set: async (items: Record<string, unknown>) => { Object.assign(records, structuredClone(items)); },
    remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete records[key]; },
  };
  const browser = {
    permissions: { onRemoved: event },
    runtime: { getManifest: () => ({}), id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onInstalled: event, onConnect: event,
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: { onChanged: event, local: storage, session: storage },
    action: { onClicked: event }, commands: { onCommand: event },
    windows: { onRemoved: event, onBoundsChanged: event },
    tabs: {
      onRemoved: event, onUpdated: event,
      get: async (id: number) => { if (!tabs.has(id)) throw new Error('Missing tab'); return tabs.get(id); },
      update: async () => {},
      sendMessage: forward,
    },
  };
  vm.runInNewContext(compiled, {
    browser, chrome: browser, URL, console: { log() {}, debug() {} }, exports: {},
    require: (path: string) => {
      if (path === './user-styles') return { replaceUserStyles: async () => {} };
      if (path.endsWith('/analytics-config')) return { analyticsConfig: {} };
      if (path.endsWith('/analytics')) return { isAnalyticsSender, createAnalytics: () => ({ start() {}, stop() {}, refresh() {}, track() {} }) };
      if (path === './comment-store') return { createCommentStore };
      if (path === './session-store') return { createSessionStore };
      if (path.endsWith('/polyfill') || path.endsWith('/page-component-context') || path.endsWith('/page-fiber-source')) return {};
      if (path.endsWith('/target')) return { IS_FIREFOX: false };
      if (path.endsWith('/panel')) return { setActionOpensPanel() {} };
      if (path.endsWith('/launch-surface')) return {
        DEFAULT_LAUNCH_SURFACE: 'side-panel', LAUNCH_SURFACE_KEY: 'dm-launch-surface', parseLaunchSurface: () => 'side-panel',
      };
      if (path === '../inspector/bridge-background') return { installInspectorBridge() {} };
      throw new Error(`Unexpected import: ${path}`);
    },
  });
  const sender = { id: browser.runtime.id, url: browser.runtime.getURL('sidepanel/index.html') };
  const send = (message: any) => {
    let respond!: (value: any) => void;
    const response = new Promise<any>(resolve => { respond = resolve; });
    assert.equal(listener(message, sender, respond), true, 'status requests must keep the channel open');
    return response;
  };
  return { send };
}

test('status with no content script in the pinned tab resolves to a structured offline report', async () => {
  const h = harness(async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); });
  const res = await h.send({ type: 'SP_GET_MCP_STATUS', targetTabId: 7 });
  assert.equal(res.connected, false);
  assert.equal(res.serverRunning, false);
  assert.equal(res.agentConnected, false);
  assert.equal(res.mcpState, 'offline');
  assert.equal(res.state, 'error');
  assert.match(String(res.error), /establish connection|pinned tab/i);
});

test('status reaches the content script and passes its report through untouched', async () => {
  const report = { connected: true, serverRunning: true, agentConnected: true, mcpState: 'connected' };
  const h = harness(async () => report);
  const res = await h.send({ type: 'SP_GET_MCP_STATUS', targetTabId: 7 });
  assert.deepEqual(res, report);
});

test('status with no pinned tab at all still resolves to a structured report', async () => {
  // No targetTabId stamp, no pinned tab registered, and no tabs.query fallback
  // in the harness — forwardToPinnedTab must still answer, never hang.
  const h = harness(async () => { throw new Error('unreached'); });
  const res = await h.send({ type: 'SP_GET_MCP_STATUS' });
  assert.equal(res.connected, false);
  assert.equal(res.state, 'error');
  assert.ok('error' in res);
});

test('reping status forwards the reping flag and stays structured on failure', async () => {
  const seen: any[] = [];
  const h = harness(async (_tabId, message) => { seen.push(message); throw new Error('Could not establish connection. Receiving end does not exist.'); });
  const res = await h.send({ type: 'SP_GET_MCP_STATUS', reping: true, targetTabId: 7 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'GET_MCP_STATUS');
  assert.equal(seen[0].reping, true);
  assert.equal(res.connected, false);
  assert.equal(res.state, 'error');
});
