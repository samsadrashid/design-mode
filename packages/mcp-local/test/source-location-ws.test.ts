import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachWebSocketServer, stopWebSocketServer } from '../src/websocket-server.ts';
import { executeLocalTool } from '../src/tools.ts';
import { state } from '../src/state.ts';

// Extension-side wire contract: a STYLE_CHANGED / DOM_CHANGED frame whose
// payload carries sourceLocation must surface it in get_changes (rows and
// items), and frames without it must stay key-free. Exercises the real WS
// server + state path, not just the state helpers.

const LOC = { file: 'src/App.tsx', line: 7, column: 3, component: 'App', framework: 'react', cleanPath: 'src/App.tsx' };

function parseTool(result: { content: Array<{ type: string; text?: string }> }) {
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse((result.content[0] as { text: string }).text);
}

async function withExtensionSocket(fn: (send: (msg: object) => void) => Promise<void>) {
  const server = http.createServer();
  attachWebSocketServer(server, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent('test-token')}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    await fn((msg: object) => ws.send(JSON.stringify(msg)));
  } finally {
    ws.close();
    stopWebSocketServer();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('get_changes surfaces sourceLocation from STYLE_CHANGED / DOM_CHANGED frames', async () => {
  state.clear();
  await withExtensionSocket(async send => {
    send({
      type: 'STYLE_CHANGED',
      payload: { id: 's1', elementId: 'dm-1', selector: '#hero', property: 'color', oldValue: 'black', newValue: 'red', timestamp: Date.now(), sourceLocation: LOC },
    });
    send({
      type: 'DOM_CHANGED',
      payload: { id: 'd1', elementId: 'dm-2', selector: '.card', action: 'move', tagName: 'div', timestamp: Date.now(), sourceLocation: LOC },
    });
    send({
      type: 'TEXT_CHANGED',
      payload: { id: 't1', elementId: 'dm-1', selector: '#hero', oldText: 'a', newText: 'b', timestamp: Date.now() },
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    const report = parseTool(await executeLocalTool('get_changes'));
    assert.deepEqual(report.styleChanges[0].sourceLocation, LOC);
    assert.deepEqual(report.domChanges[0].sourceLocation, LOC);
    assert.equal('sourceLocation' in report.textChanges[0], false);
    assert.doesNotMatch(JSON.stringify(report), /"sourceLocation":null/);

    const items = new Map<string, any>(report.items.map((i: any) => [i.id, i]));
    assert.deepEqual(items.get('s1').sourceLocation, LOC);
    assert.deepEqual(items.get('d1').sourceLocation, LOC);
    assert.equal('sourceLocation' in items.get('t1'), false);
  });
});

test('SESSION_UPDATE rows keep sourceLocation through the wholesale replace', async () => {
  state.clear();
  await withExtensionSocket(async send => {
    send({
      type: 'SESSION_UPDATE',
      payload: {
        pageUrl: 'https://example.com/app',
        pageTitle: 'App',
        styleChanges: [{ id: 's9', elementId: 'dm-1', selector: '#hero', property: 'paddingLeft', oldValue: '12px', newValue: '24px', timestamp: Date.now(), sourceLocation: LOC }],
        textChanges: [],
        domChanges: [],
        comments: [],
      },
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    const report = parseTool(await executeLocalTool('get_changes'));
    assert.deepEqual(report.styleChanges[0].sourceLocation, LOC);
  });
});
