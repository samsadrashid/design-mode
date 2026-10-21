import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeVLQ,
  decodeMappings,
  decodeSourceMap,
  originalPositionFor,
  parseSourceMappingURL,
  resolveMapURL,
  joinSourceRoot,
  loadSourceMap,
  type DecodedSourceMap,
} from './sourcemap-resolver.ts';
import { resolveSourceLocation, toSourceLocation } from './source-detection.ts';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVLQ(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += B64[digit];
  } while (vlq > 0);
  return out;
}

function buildMappings(entries: number[][]): string {
  const lines: string[][] = [];
  let pSrc = 0, pLine = 0, pCol = 0, pName = 0;
  let curLine = -1, prevCol = 0;
  for (const e of entries) {
    while (curLine < e[0]) { lines.push([]); curLine++; prevCol = 0; }
    const parts = [encodeVLQ(e[1] - prevCol)];
    prevCol = e[1];
    if (e.length >= 5) {
      parts.push(encodeVLQ(e[2] - pSrc), encodeVLQ(e[3] - pLine), encodeVLQ(e[4] - pCol));
      pSrc = e[2]; pLine = e[3]; pCol = e[4];
      if (e.length >= 6) { parts.push(encodeVLQ(e[5] - pName)); pName = e[5]; }
    }
    lines[e[0]].push(parts.join(''));
  }
  return lines.map(l => l.join(',')).join(';');
}

function fetchStub(body: string | null, opts: { status?: number; contentLength?: string | null } = {}) {
  let calls = 0;
  const impl = (_url: string, _init?: { signal?: AbortSignal }) => {
    calls++;
    return Promise.resolve({
      ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
      status: opts.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? (opts.contentLength ?? null) : null) },
      text: () => Promise.resolve(body ?? ''),
    });
  };
  return { impl: impl as unknown as typeof fetch, calls: () => calls };
}

function mapFixture(): DecodedSourceMap {
  const map = decodeSourceMap(JSON.stringify({
    version: 3,
    sourceRoot: 'src/',
    sources: ['views/App.tsx', 'styles/card.css'],
    names: ['App'],
    mappings: buildMappings([
      [0, 0, 0, 0, 0, 0],
      [0, 40, 0, 2, 0, 0],
      [1, 0, 1, 0, 0],
    ]),
  }));
  assert.ok(map);
  return map;
}

describe('decodeVLQ', () => {
  it('decodes single and multi-digit values', () => {
    assert.deepEqual(decodeVLQ('A'), [0]);
    assert.deepEqual(decodeVLQ('C'), [1]);
    assert.deepEqual(decodeVLQ('D'), [-1]);
    assert.deepEqual(decodeVLQ('e'), [15]);
    assert.deepEqual(decodeVLQ('gB'), [16]);
    assert.deepEqual(decodeVLQ('+B'), [31]);
    assert.deepEqual(decodeVLQ('gC'), [32]);
    assert.deepEqual(decodeVLQ('hB'), [-16]);
    assert.deepEqual(decodeVLQ('AAAA'), [0, 0, 0, 0]);
  });

  it('round-trips against an independent encoder', () => {
    for (const v of [0, 1, -1, 15, 16, 31, 32, -16, 1000, -1000, 1 << 20, -(1 << 20)]) {
      assert.deepEqual(decodeVLQ(encodeVLQ(v)), [v]);
    }
  });

  it('rejects invalid digits and dangling continuations', () => {
    assert.throws(() => decodeVLQ('A*A'));
    assert.throws(() => decodeVLQ('g'));
  });
});

describe('decodeMappings', () => {
  it('decodes generated line/col plus source deltas', () => {
    const segments = decodeMappings(buildMappings([
      [0, 0, 0, 0, 0],
      [0, 40, 0, 2, 0],
      [1, 0, 1, 0, 0],
    ]));
    assert.deepEqual(segments, [
      { genLine: 0, genCol: 0, srcIdx: 0, srcLine: 0, srcCol: 0 },
      { genLine: 0, genCol: 40, srcIdx: 0, srcLine: 2, srcCol: 0 },
      { genLine: 1, genCol: 0, srcIdx: 1, srcLine: 0, srcCol: 0 },
    ]);
  });

  it('carries name indices when the segment has a fifth field', () => {
    const segments = decodeMappings(buildMappings([[0, 0, 0, 0, 0, 3]]));
    assert.deepEqual(segments, [
      { genLine: 0, genCol: 0, srcIdx: 0, srcLine: 0, srcCol: 0, nameIdx: 3 },
    ]);
  });

  it('keeps 1-field segments as unmapped region markers', () => {
    const segments = decodeMappings(buildMappings([[0, 0], [0, 10, 0, 0, 0], [0, 20]]));
    assert.deepEqual(segments, [
      { genLine: 0, genCol: 0 },
      { genLine: 0, genCol: 10, srcIdx: 0, srcLine: 0, srcCol: 0 },
      { genLine: 0, genCol: 20 },
    ]);
  });

  it('advances generated lines across empty mappings entries', () => {
    const segments = decodeMappings(buildMappings([[0, 0, 0, 0, 0], [2, 4, 0, 0, 0]]));
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[1], { genLine: 2, genCol: 4, srcIdx: 0, srcLine: 0, srcCol: 0 });
  });
});

describe('decodeSourceMap', () => {
  it('parses a valid v3 map', () => {
    const map = decodeSourceMap(JSON.stringify({
      version: 3, file: 'app.js', sourceRoot: 'src/',
      sources: ['a.tsx', null], names: ['x'],
      mappings: buildMappings([[0, 0, 0, 0, 0]]),
    }));
    assert.ok(map);
    assert.equal(map.version, 3);
    assert.equal(map.sourceRoot, 'src/');
    assert.deepEqual(map.sources, ['a.tsx', null]);
    assert.equal(map.segments.length, 1);
  });

  it('returns null for malformed payloads', () => {
    assert.equal(decodeSourceMap('not json'), null);
    assert.equal(decodeSourceMap('{"version":2,"sources":[],"mappings":""}'), null);
    assert.equal(decodeSourceMap('{"version":3,"sources":"x","mappings":"AAAA"}'), null);
    assert.equal(decodeSourceMap('{"version":3,"sources":["a"],"mappings":"A*A"}'), null);
    assert.equal(decodeSourceMap('{"version":3,"sources":["a"],"names":[],"mappings":"g"}'), null);
  });
});

describe('originalPositionFor', () => {
  it('finds the greatest-lower-bound mapping on the same line', () => {
    const map = mapFixture();
    assert.deepEqual(originalPositionFor(map, 0, 50), { file: 'src/views/App.tsx', line: 2, column: 0, component: 'App' });
    assert.deepEqual(originalPositionFor(map, 0, 0), { file: 'src/views/App.tsx', line: 0, column: 0, component: 'App' });
    assert.deepEqual(originalPositionFor(map, 0, 39), { file: 'src/views/App.tsx', line: 0, column: 0, component: 'App' });
    assert.deepEqual(originalPositionFor(map, 1, 0), { file: 'src/styles/card.css', line: 0, column: 0 });
  });

  it('joins sourceRoot without double slashes', () => {
    const map = mapFixture();
    const hit = originalPositionFor(map, 1, 0);
    assert.equal(hit?.file, 'src/styles/card.css');
  });

  it('returns null off-line, in unmapped regions, and out of range', () => {
    const map = mapFixture();
    assert.equal(originalPositionFor(map, 3, 0), null);
    assert.deepEqual(originalPositionFor(map, 0, 100000), { file: 'src/views/App.tsx', line: 2, column: 0, component: 'App' });
    assert.equal(originalPositionFor(map, -1, 0), null);
    const withGap = decodeSourceMap(JSON.stringify({
      version: 3, sources: ['a.tsx'], names: [],
      mappings: buildMappings([[0, 0], [0, 10, 0, 1, 0], [0, 20]]),
    }));
    assert.ok(withGap);
    assert.equal(originalPositionFor(withGap, 0, 5), null);
    assert.deepEqual(originalPositionFor(withGap, 0, 12), { file: 'a.tsx', line: 1, column: 0 });
  });
});

describe('joinSourceRoot', () => {
  it('handles missing, slash-less, and absolute sources', () => {
    assert.equal(joinSourceRoot(undefined, 'a.ts'), 'a.ts');
    assert.equal(joinSourceRoot('src', 'a.ts'), 'src/a.ts');
    assert.equal(joinSourceRoot('src/', 'a.ts'), 'src/a.ts');
    assert.equal(joinSourceRoot('src/', '/abs/a.ts'), 'src//abs/a.ts');
  });
});

describe('parseSourceMappingURL', () => {
  it('reads JS and CSS comment forms', () => {
    assert.equal(parseSourceMappingURL('code();\n//# sourceMappingURL=app.js.map'), 'app.js.map');
    assert.equal(parseSourceMappingURL('.x{}\n/*@ sourceMappingURL=app.css.map */'), 'app.css.map');
    assert.equal(parseSourceMappingURL('.x{}\n/*# sourceMappingURL=app.css.map */'), 'app.css.map');
    assert.equal(parseSourceMappingURL('//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map'), 'b.map');
    assert.equal(parseSourceMappingURL('no comment here'), null);
  });
});

describe('resolveMapURL', () => {
  it('passes data URIs through and resolves relatives', () => {
    const data = 'data:application/json;base64,e30=';
    assert.equal(resolveMapURL(data, 'https://app.test/x.js'), data);
    assert.equal(resolveMapURL('app.js.map', 'https://app.test/assets/x.js'), 'https://app.test/assets/app.js.map');
    assert.equal(resolveMapURL('/maps/x.map', 'https://app.test/assets/x.js'), 'https://app.test/maps/x.map');
    assert.equal(resolveMapURL('x.map', null), null);
  });
});

describe('loadSourceMap', () => {
  it('decodes base64 data URIs without fetching', async () => {
    const json = JSON.stringify({ version: 3, sources: ['a.tsx'], names: [], mappings: buildMappings([[0, 0, 0, 0, 0]]) });
    const uri = 'data:application/json;base64,' + Buffer.from(json).toString('base64');
    const { impl, calls } = fetchStub('');
    const map = await loadSourceMap(uri, { pageOrigin: 'https://app.test', fetchImpl: impl });
    assert.ok(map);
    assert.deepEqual(originalPositionFor(map, 0, 0), { file: 'a.tsx', line: 0, column: 0 });
    assert.equal(calls(), 0);
  });

  it('decodes percent-encoded data URIs', async () => {
    const json = JSON.stringify({ version: 3, sources: ['b.tsx'], names: [], mappings: buildMappings([[0, 0, 0, 0, 0]]) });
    const uri = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    const map = await loadSourceMap(uri, { pageOrigin: 'https://app.test' });
    assert.ok(map);
    assert.equal(map.sources[0], 'b.tsx');
  });

  it('rejects cross-origin maps before fetching', async () => {
    const { impl, calls } = fetchStub('{}');
    const map = await loadSourceMap('https://evil.test/x.map', { pageOrigin: 'https://app.test', fetchImpl: impl });
    assert.equal(map, null);
    assert.equal(calls(), 0);
  });

  it('rejects non-http schemes', async () => {
    const map = await loadSourceMap('file:///etc/x.map', { pageOrigin: 'file://' });
    assert.equal(map, null);
  });

  it('honours the size cap via content-length', async () => {
    const { impl, calls } = fetchStub('{}', { contentLength: String(6 * 1024 * 1024) });
    const map = await loadSourceMap('https://app.test/cap.map', { pageOrigin: 'https://app.test', fetchImpl: impl });
    assert.equal(map, null);
    assert.equal(calls(), 1);
  });

  it('honours the size cap on the body itself', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    const { impl } = fetchStub(big);
    const map = await loadSourceMap('https://app.test/big.map', { pageOrigin: 'https://app.test', fetchImpl: impl });
    assert.equal(map, null);
  });

  it('caches per URL, including misses', async () => {
    const json = JSON.stringify({ version: 3, sources: ['a.tsx'], names: [], mappings: buildMappings([[0, 0, 0, 0, 0]]) });
    const good = fetchStub(json);
    const goodOpts = { pageOrigin: 'https://app.test', fetchImpl: good.impl };
    const first = await loadSourceMap('https://app.test/good.map', goodOpts);
    const again = await loadSourceMap('https://app.test/good.map', goodOpts);
    assert.ok(first && again);
    assert.equal(good.calls(), 1);
    const bad = fetchStub('not json');
    const badOpts = { pageOrigin: 'https://app.test', fetchImpl: bad.impl };
    const miss = await loadSourceMap('https://app.test/bad.map', badOpts);
    const missAgain = await loadSourceMap('https://app.test/bad.map', badOpts);
    assert.equal(miss, null);
    assert.equal(missAgain, null);
    assert.equal(bad.calls(), 1);
  });

  it('returns null for malformed map payloads fetched same-origin', async () => {
    const { impl } = fetchStub('{"version":2}');
    const map = await loadSourceMap('https://app.test/broken.map', { pageOrigin: 'https://app.test', fetchImpl: impl });
    assert.equal(map, null);
  });

  it('returns null when fetch fails', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const map = await loadSourceMap('https://app.test/offline.map', { pageOrigin: 'https://app.test', fetchImpl: failing });
    assert.equal(map, null);
  });
});

describe('toSourceLocation', () => {
  it('converts 0-based map positions to 1-based SourceLocation', () => {
    const loc = toSourceLocation({ file: 'src/views/App.tsx', line: 3, column: 9, component: 'App' });
    assert.equal(loc.file, 'src/views/App.tsx');
    assert.equal(loc.line, 4);
    assert.equal(loc.column, 10);
    assert.equal(loc.component, 'App');
    assert.equal(loc.framework, 'unknown');
    assert.equal(loc.cleanPath, 'src/views/App.tsx');
  });
});

describe('resolveSourceLocation', () => {
  it('returns null for hint-less elements outside a browser', async () => {
    const el = {} as HTMLElement;
    assert.equal(await resolveSourceLocation(el), null);
  });
});
