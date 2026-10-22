import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceLocation } from './source-detection.ts';
import { sanitizeFiberSource } from './page-fiber-source.ts';

// The fiber bridge crosses the MAIN→isolated world boundary, so its payloads
// are untrusted. These tests pin the validator and the resolution order
// (isolated-world hints → MAIN-world fiber → source maps) against a stubbed
// browser.runtime bridge.
function withBrowserStub(impl: (msg: unknown) => unknown): { calls: unknown[]; restore: () => void } {
  const calls: unknown[] = [];
  const previous = (globalThis as any).browser;
  (globalThis as any).browser = {
    runtime: {
      sendMessage: async (msg: unknown) => {
        calls.push(msg);
        return impl(msg);
      },
    },
  };
  return {
    calls,
    restore: () => { (globalThis as any).browser = previous; },
  };
}

const elWithId = (id: string | null): HTMLElement =>
  ({ getAttribute: (name: string) => (name === 'data-dm-id' ? id : null) }) as unknown as HTMLElement;

describe('sanitizeFiberSource', () => {
  it('accepts well-formed payloads', () => {
    assert.deepEqual(sanitizeFiberSource({ file: 'src/App.tsx', line: 7, column: 4, component: 'App' }),
      { file: 'src/App.tsx', line: 7, column: 4, component: 'App' });
    assert.deepEqual(sanitizeFiberSource({ file: '/abs/Page.tsx', line: 1 }),
      { file: '/abs/Page.tsx', line: 1 });
  });

  it('rejects non-string files, oversized strings, and bad numbers', () => {
    assert.equal(sanitizeFiberSource(null), null);
    assert.equal(sanitizeFiberSource('App.tsx'), null);
    assert.equal(sanitizeFiberSource({ file: 42, line: 1 }), null);
    assert.equal(sanitizeFiberSource({ file: '', line: 1 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a'.repeat(501), line: 1 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: Number.NaN }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: -1 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: 1.5 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx' }), null); // line missing
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: 1, column: Number.NaN }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: 1, column: -2 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: 1, column: 2 ** 53 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: 1, component: 7 }), null);
    assert.equal(sanitizeFiberSource({ file: 'a.tsx', line: 1, component: 'x'.repeat(201) }), null);
  });
});

describe('resolveSourceLocation fallback order', () => {
  it('isolated-world hints win and the MAIN-world bridge is never called', async () => {
    const stub = withBrowserStub(() => assert.fail('bridge must not be called when an isolated hint resolves'));
    try {
      const el = {
        getAttribute: (name: string) => (name === 'data-dm-id' ? 'dm-1' : null),
        __reactFiber$fixture: { _debugSource: { fileName: 'iso/App.tsx', lineNumber: 3 }, type: { name: 'Iso' } },
      } as unknown as HTMLElement;
      const loc = await resolveSourceLocation(el);
      assert.equal(loc?.file, 'iso/App.tsx');
      assert.equal(loc?.framework, 'react');
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  it('MAIN-world fiber hit comes before the sourcemap fallback', async () => {
    const stub = withBrowserStub((msg) => {
      assert.deepEqual(msg, { type: 'GET_FIBER_SOURCE', elementId: 'dm-1' });
      return { file: 'src/App.tsx', line: 7, column: 4, component: 'App' };
    });
    const oldDocument = globalThis.document;
    try {
      // No document: a sourcemap attempt would throw, making an accidental
      // fallback visibly fatal instead of silently ordering wrong.
      delete (globalThis as any).document;
      const loc = await resolveSourceLocation(elWithId('dm-1'));
      assert.deepEqual(loc, {
        file: 'src/App.tsx',
        line: 7,
        column: 4,
        component: 'App',
        framework: 'react',
        bundlerUrl: 'src/App.tsx',
        cleanPath: 'src/App.tsx',
      });
      assert.equal(stub.calls.length, 1);
    } finally {
      globalThis.document = oldDocument;
      stub.restore();
    }
  });

  it('an invalid bridge payload falls through to the sourcemap fallback', async () => {
    const stub = withBrowserStub(() => ({ file: 42, line: 3 }));
    const oldDocument = globalThis.document;
    try {
      delete (globalThis as any).document;
      assert.equal(await resolveSourceLocation(elWithId('dm-1')), null);
      assert.equal(stub.calls.length, 1);
    } finally {
      globalThis.document = oldDocument;
      stub.restore();
    }
  });

  it('untagged elements skip the bridge entirely', async () => {
    const stub = withBrowserStub(() => ({ file: 'x.tsx', line: 1 }));
    try {
      assert.equal(await resolveSourceLocation(elWithId(null)), null);
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });
});
