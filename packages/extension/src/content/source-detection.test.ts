import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceLocation, findSameOriginModuleUrl } from './source-detection.ts';
import { sanitizeFiberSource } from './page-fiber-source.ts';
import { applySourcemapFetchValue } from './sourcemap-fetch-setting.ts';

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

// ── React dev report refinement (bundler-intermediate line drift) ──
//
// React's _debugSource reports JSX positions in the bundler's refresh-wrapped
// intermediate module; with Vite's 19-line preamble the authored button at
// Card.jsx:8 is reported as line 27 — past the 11-line authored EOF. These
// tests pin the refinement to the authored position via the served module's
// source map, and the raw report being kept whenever a map is unavailable.

const CARD_FILE = '/proj/src/Card.jsx';

function withEnvironment(opts: {
  origin?: string;
  resourceUrls?: string[];
  scriptSrcs?: string[];
  fetchRoutes?: Record<string, string>;
  fetchCalls?: string[];
}): { restore: () => void } {
  const saved = {
    location: (globalThis as any).location,
    performance: (globalThis as any).performance,
    document: (globalThis as any).document,
    fetch: (globalThis as any).fetch,
  };
  if (opts.origin !== undefined) (globalThis as any).location = { origin: opts.origin };
  if (opts.resourceUrls !== undefined) {
    (globalThis as any).performance = { getEntriesByType: () => opts.resourceUrls!.map(name => ({ name })) };
  }
  if (opts.scriptSrcs !== undefined) {
    (globalThis as any).document = { querySelectorAll: () => opts.scriptSrcs!.map(src => ({ getAttribute: (n: string) => (n === 'src' ? src : null) })) };
  }
  if (opts.fetchRoutes !== undefined) {
    const routes = opts.fetchRoutes;
    (globalThis as any).fetch = (url: string) => {
      opts.fetchCalls?.push(url);
      const body = routes[url];
      if (body === undefined) return Promise.reject(new Error(`unexpected fetch ${url}`));
      return Promise.resolve({ ok: true, headers: { get: () => null }, text: () => Promise.resolve(body) });
    };
  }
  return {
    restore: () => {
      (globalThis as any).location = saved.location;
      (globalThis as any).performance = saved.performance;
      (globalThis as any).document = saved.document;
      (globalThis as any).fetch = saved.fetch;
    },
  };
}

const MAIN_FIBER_HIT = { file: CARD_FILE, line: 27, column: 7, component: 'Card' };

function withMainFiberHit(): { calls: unknown[]; restore: () => void } {
  return withBrowserStub((msg) => {
    assert.deepEqual(msg, { type: 'GET_FIBER_SOURCE', elementId: 'dm-1' });
    return { ...MAIN_FIBER_HIT };
  });
}

describe('findSameOriginModuleUrl', () => {
  const origin = 'http://127.0.0.1:5173';

  it('derives the module URL from same-origin resources, dropping cross-origin and file candidates', () => {
    const env = withEnvironment({
      resourceUrls: ['https://evil.test/src/Card.jsx', 'http://127.0.0.1:5173/src/Card.jsx?t=123', 'file:///proj/src/Card.jsx'],
      scriptSrcs: [],
    });
    try {
      assert.equal(findSameOriginModuleUrl(CARD_FILE, origin), 'http://127.0.0.1:5173/src/Card.jsx?t=123');
    } finally {
      env.restore();
    }
  });

  it('matches /@fs module URLs against the absolute authored path', () => {
    const env = withEnvironment({ resourceUrls: [`http://127.0.0.1:5173/@fs${CARD_FILE}`], scriptSrcs: [] });
    try {
      assert.equal(findSameOriginModuleUrl(CARD_FILE, origin), `http://127.0.0.1:5173/@fs${CARD_FILE}`);
    } finally {
      env.restore();
    }
  });

  it('prefers the longest matching pathname', () => {
    const env = withEnvironment({
      resourceUrls: ['http://127.0.0.1:5173/src/Card.jsx', 'http://127.0.0.1:5173/app/src/Card.jsx'],
      scriptSrcs: [],
    });
    try {
      assert.equal(findSameOriginModuleUrl('/proj/app/src/Card.jsx', origin), 'http://127.0.0.1:5173/app/src/Card.jsx');
    } finally {
      env.restore();
    }
  });

  it('returns null with only cross-origin candidates, or no candidates at all', () => {
    const evilOnly = withEnvironment({ resourceUrls: ['https://evil.test/src/Card.jsx'], scriptSrcs: [] });
    try {
      assert.equal(findSameOriginModuleUrl(CARD_FILE, origin), null);
    } finally {
      evilOnly.restore();
    }
    const empty = withEnvironment({ resourceUrls: [], scriptSrcs: [] });
    try {
      assert.equal(findSameOriginModuleUrl(CARD_FILE, origin), null);
    } finally {
      empty.restore();
    }
  });

  it('rejects reported paths carrying control characters', () => {
    assert.equal(findSameOriginModuleUrl('http://127.0.0.1:5173\n/src/Card.jsx', origin), null);
  });
});

describe('resolveSourceLocation react refinement', () => {
  function cardModule(withMap: boolean): string {
    const body = [
      'import { jsxDEV } from "react/jsx-dev-runtime";',
      ...Array.from({ length: 18 }, () => '// filler'),
      '    /* @__PURE__ */ jsxDEV("button", { id: "target-btn" }, void 0, false, {',
      `      fileName: "${CARD_FILE}",`,
      '      lineNumber: 27,',
      '      columnNumber: 7',
      '    }, this);',
    ];
    if (withMap) {
      const entries: number[][] = [];
      for (let genLine = 19; genLine <= 23; genLine++) entries.push([genLine, 0, 0, 7, 6]);
      const map = { version: 3, sources: ['Card.jsx'], names: [], mappings: encodeAll(entries) };
      body.push('//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'));
    }
    return body.join('\n') + '\n';
  }

  // Minimal independent VLQ encoder for the mapped-button fixture.
  function encodeAll(entries: number[][]): string {
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const enc = (v: number) => {
      let vlq = v < 0 ? ((-v) << 1) + 1 : v << 1;
      let out = '';
      do {
        let d = vlq & 31;
        vlq >>>= 5;
        if (vlq > 0) d |= 32;
        out += B64[d];
      } while (vlq > 0);
      return out;
    };
    const lines: string[][] = [];
    let pGenCol = 0, pSrcLine = 0, pSrcCol = 0;
    let cur = -1;
    for (const [g, c, , sl, sc] of entries) {
      while (cur < g) { lines.push([]); cur++; pGenCol = 0; }
      lines[g].push([enc(c - pGenCol), enc(0), enc(sl - pSrcLine), enc(sc - pSrcCol)].join(''));
      pGenCol = c; pSrcLine = sl; pSrcCol = sc;
    }
    return lines.map(l => l.join(',')).join(';');
  }

  it('refines the line-27 fiber report to the authored line 8 via the served module map', async () => {
    applySourcemapFetchValue(true);
    const stub = withMainFiberHit();
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://mapped.test',
      resourceUrls: ['https://mapped.test/src/Card.jsx'],
      scriptSrcs: [],
      fetchRoutes: { 'https://mapped.test/src/Card.jsx': cardModule(true) },
      fetchCalls,
    });
    try {
      const loc = await resolveSourceLocation(elWithId('dm-1'));
      assert.equal(loc?.line, 8);
      assert.equal(loc?.column, 7);
      assert.equal(loc?.file, CARD_FILE);
      assert.equal(loc?.framework, 'react');
      assert.equal(loc?.component, 'Card');
      assert.equal(loc?.bundlerUrl, CARD_FILE);
      assert.deepEqual(fetchCalls, ['https://mapped.test/src/Card.jsx']);
    } finally {
      env.restore();
      stub.restore();
    }
  });

  it('keeps the raw intermediate report when the module has no source map', async () => {
    applySourcemapFetchValue(true);
    const stub = withMainFiberHit();
    const env = withEnvironment({
      origin: 'https://plain.test',
      resourceUrls: ['https://plain.test/src/Card.jsx'],
      scriptSrcs: [],
      fetchRoutes: { 'https://plain.test/src/Card.jsx': cardModule(false) },
    });
    try {
      const loc = await resolveSourceLocation(elWithId('dm-1'));
      assert.deepEqual(loc, {
        file: CARD_FILE,
        line: 27,
        column: 7,
        component: 'Card',
        framework: 'react',
        bundlerUrl: CARD_FILE,
        cleanPath: CARD_FILE,
      });
    } finally {
      env.restore();
      stub.restore();
    }
  });

  it('keeps the raw report and fetches nothing when no same-origin module is loaded', async () => {
    applySourcemapFetchValue(true);
    const stub = withMainFiberHit();
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://app.test',
      resourceUrls: [],
      scriptSrcs: [],
      fetchRoutes: {},
      fetchCalls,
    });
    try {
      const loc = await resolveSourceLocation(elWithId('dm-1'));
      assert.equal(loc?.line, 27);
      assert.deepEqual(fetchCalls, []);
    } finally {
      env.restore();
      stub.restore();
    }
  });

  it('does not refine non-react reports', async () => {
    const stub = withBrowserStub(() => assert.fail('bridge must not run when a framework hint resolves'));
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://app.test',
      resourceUrls: ['https://app.test/src/Card.jsx'],
      scriptSrcs: [],
      fetchRoutes: {},
      fetchCalls,
    });
    const el = {
      getAttribute: () => 'dm-1',
      __svelte_meta: { loc: { file: '/proj/src/Card.svelte', line: 27, column: 7 } },
    } as unknown as HTMLElement;
    try {
      const loc = await resolveSourceLocation(el);
      assert.equal(loc?.framework, 'svelte');
      assert.equal(loc?.line, 27);
      assert.deepEqual(fetchCalls, []);
    } finally {
      env.restore();
      stub.restore();
    }
  });
});

// ── dm-sourcemap-fetch gate ──
//
// Fetches are same-origin reads, but still outbound calls: the stored
// setting must drop every fetch path while framework hints keep working.
// Distinct hosts per test keep the resolver's module-level caches from
// serving a cross-test hit.

describe('sourcemap fetch setting gates network resolution', () => {
  it('keeps the raw React report and fetches nothing when the setting is off', async () => {
    applySourcemapFetchValue(false);
    const stub = withMainFiberHit();
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://off.test',
      resourceUrls: ['https://off.test/src/Card.jsx'],
      scriptSrcs: [],
      fetchRoutes: { 'https://off.test/src/Card.jsx': 'unreachable' },
      fetchCalls,
    });
    try {
      const loc = await resolveSourceLocation(elWithId('dm-1'));
      assert.equal(loc?.line, 27);
      assert.equal(loc?.framework, 'react');
      assert.deepEqual(fetchCalls, []);
    } finally {
      env.restore();
      stub.restore();
      applySourcemapFetchValue(true);
    }
  });

  it('framework hints still resolve with the setting off', async () => {
    applySourcemapFetchValue(false);
    const stub = withBrowserStub(() => assert.fail('isolated hints must short-circuit the bridge'));
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://hints.test',
      resourceUrls: ['https://hints.test/src/Card.jsx'],
      scriptSrcs: [],
      fetchRoutes: {},
      fetchCalls,
    });
    const el = {
      getAttribute: () => 'dm-1',
      __reactFiber$fixture: {
        _debugSource: { fileName: '/proj/src/Card.jsx', lineNumber: 27, columnNumber: 7 },
        type: { name: 'Card' },
      },
    } as unknown as HTMLElement;
    try {
      const loc = await resolveSourceLocation(el);
      assert.equal(loc?.file, '/proj/src/Card.jsx');
      assert.equal(loc?.line, 27);
      assert.equal(loc?.framework, 'react');
      assert.deepEqual(fetchCalls, []);
    } finally {
      env.restore();
      stub.restore();
      applySourcemapFetchValue(true);
    }
  });

  it('a same-origin stylesheet falls back through the map when the setting is on', async () => {
    applySourcemapFetchValue(true);
    const cssUrl = 'https://on.test/card.css';
    const mapUrl = 'https://on.test/card.css.map';
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://on.test',
      resourceUrls: [],
      scriptSrcs: [],
      fetchRoutes: {
        [cssUrl]: '.gate-card { color: seagreen; }' + String.fromCharCode(10) +
          '//# sourceMappingURL=card.css.map',
        [mapUrl]: JSON.stringify({
          version: 3,
          sources: ['card.src.css'],
          names: ['GateCard'],
          // One segment: generated (0,0) → authored card.src.css (7,6).
          // VLQ(0)='A', VLQ(7)='O', VLQ(6)='M' → fields [0, 0, 7, 6].
          mappings: 'AAOM',
        }),
      },
      fetchCalls,
    });
    (globalThis as any).document = {
      ...((globalThis as any).document ?? {}),
      styleSheets: [{
        href: cssUrl,
        ownerNode: { hasAttribute: () => false },
        cssRules: [{
          selectorText: '.gate-card',
          style: { getPropertyValue: (name: string) => (name === 'color' ? 'seagreen' : '') },
        }],
      }],
    };
    const el = {
      getAttribute: () => null,
      matches: (sel: string) => sel === '.gate-card',
    } as unknown as HTMLElement;
    try {
      const loc = await resolveSourceLocation(el);
      assert.equal(loc?.file, 'card.src.css');
      assert.equal(loc?.line, 8);
      assert.deepEqual(fetchCalls, [cssUrl, mapUrl]);
    } finally {
      env.restore();
      applySourcemapFetchValue(true);
    }
  });

  it('the same stylesheet resolves to null with zero fetches when the setting is off', async () => {
    const cssUrl = 'https://disabled.test/card.css';
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://disabled.test',
      resourceUrls: [],
      scriptSrcs: [],
      fetchRoutes: {},
      fetchCalls,
    });
    (globalThis as any).document = {
      ...((globalThis as any).document ?? {}),
      styleSheets: [{
        href: cssUrl,
        ownerNode: { hasAttribute: () => false },
        cssRules: [{
          selectorText: '.gate-card',
          style: { getPropertyValue: (name: string) => (name === 'color' ? 'seagreen' : '') },
        }],
      }],
    };
    const el = {
      getAttribute: () => null,
      matches: (sel: string) => sel === '.gate-card',
    } as unknown as HTMLElement;
    try {
      applySourcemapFetchValue(false);
      const loc = await resolveSourceLocation(el);
      assert.equal(loc, null);
      assert.deepEqual(fetchCalls, []);
    } finally {
      env.restore();
      applySourcemapFetchValue(true);
    }
  });

  it('re-enabling at runtime restores fetch-based resolution', async () => {
    applySourcemapFetchValue(false);
    const stub = withMainFiberHit();
    const fetchCalls: string[] = [];
    const env = withEnvironment({
      origin: 'https://runtime.test',
      resourceUrls: ['https://runtime.test/src/Card.jsx'],
      scriptSrcs: [],
      // No sourceMappingURL comment on the module: refinement fetches the
      // text once, finds no map, keeps the raw report — enough to prove
      // fetches resumed after the flip.
      fetchRoutes: { 'https://runtime.test/src/Card.jsx': 'const x = 1;' },
      fetchCalls,
    });
    try {
      const off = await resolveSourceLocation(elWithId('dm-1'));
      assert.equal(off?.line, 27);
      assert.deepEqual(fetchCalls, []);
      applySourcemapFetchValue(true);
      const on = await resolveSourceLocation(elWithId('dm-1'));
      assert.equal(on?.line, 27);
      assert.equal(fetchCalls.length, 1);
    } finally {
      env.restore();
      stub.restore();
      applySourcemapFetchValue(true);
    }
  });
});
