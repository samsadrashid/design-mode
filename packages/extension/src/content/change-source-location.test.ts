import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { validateImportPayload } from './import-validation';
import type { SourceLocation } from '@shared/types';

// The source-location attach block lives inside change-tracker.ts as one
// contiguous excerpt (same convention as move-report-restore / file-route-
// regression). The full module touches browser.* at load, so tests slice
// the block, transpile it and bind its collaborators as function params.
function loadAttach(
  styleChanges: any[],
  textChanges: any[],
  domChanges: any[],
  resolveSourceLocation: (el: any) => Promise<SourceLocation | null>,
  persistSession: () => void,
) {
  const source = readFileSync(new URL('./change-tracker.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const sourceLocationCache');
  const end = source.indexOf('export function setChangesStatus');
  assert.ok(start >= 0 && end > start, 'source-location attach block is missing from change-tracker.ts');
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const grab = vm.runInThisContext(
    `(function (styleChanges, textChanges, domChanges, resolveSourceLocation, persistSession) { ${js}; return { attachSourceLocation }; })`,
  );
  return grab(styleChanges, textChanges, domChanges, resolveSourceLocation, persistSession) as {
    attachSourceLocation: (el: unknown, change: unknown, sync: (c: unknown) => void) => Promise<void>;
  };
}

const LOC: SourceLocation = { file: 'src/App.tsx', line: 7, column: 3, component: 'App', framework: 'react' };
const el = {} as unknown as HTMLElement; // WeakMap key only — never dereferenced by the mock

test('sourceLocation attaches asynchronously after the change is recorded', async () => {
  const change: any = { id: 's1', elementId: 'dm-1', selector: '#hero', property: 'color', timestamp: 1 };
  const styleChanges = [change];
  let resolutions = 0;
  let persisted = 0;
  const sent: unknown[] = [];
  const { attachSourceLocation } = loadAttach(styleChanges, [], [], el2 => {
    assert.equal(el2, el);
    resolutions += 1;
    return Promise.resolve(LOC);
  }, () => { persisted += 1; });
  const done = attachSourceLocation(el, change, c => { sent.push(c); });
  // Nothing is attached synchronously — recording and the first send have
  // already happened by the time the producer fires this.
  assert.equal('sourceLocation' in change, false);
  await done;
  assert.equal(resolutions, 1);
  assert.deepEqual(change.sourceLocation, LOC);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], change, 'the live record is re-synced, not a copy');
  assert.equal(persisted, 1, 'storage is refreshed so reloads keep the location');
});

test('a failing resolver leaves the change without the key and never throws', async () => {
  const change: any = { id: 's1', timestamp: 1 };
  const styleChanges = [change];
  const sent: unknown[] = [];
  const { attachSourceLocation } = loadAttach(styleChanges, [], [],
    () => Promise.reject(new Error('sourcemap offline')), () => { throw new Error('must not persist'); });
  await attachSourceLocation(el, change, c => { sent.push(c); });
  assert.equal('sourceLocation' in change, false);
  assert.deepEqual(sent, []);
});

test('a null resolution omits the key — reports never carry a null location', async () => {
  const change: any = { id: 's1', timestamp: 1 };
  const styleChanges = [change];
  const { attachSourceLocation } = loadAttach(styleChanges, [], [], () => Promise.resolve(null), () => {});
  await attachSourceLocation(el, change, () => assert.fail('must not re-sync'));
  assert.equal('sourceLocation' in change, false);
});

test('repeated edits on one element resolve once (WeakMap cache)', async () => {
  const a: any = { id: 's1', timestamp: 1 };
  const b: any = { id: 's2', timestamp: 2 };
  const styleChanges = [a, b];
  let resolutions = 0;
  const { attachSourceLocation } = loadAttach(styleChanges, [], [], () => {
    resolutions += 1;
    return Promise.resolve(LOC);
  }, () => {});
  await Promise.all([attachSourceLocation(el, a, () => {}), attachSourceLocation(el, b, () => {})]);
  await attachSourceLocation(el, a, () => {});
  assert.equal(resolutions, 1);
  assert.deepEqual(a.sourceLocation, LOC);
  assert.deepEqual(b.sourceLocation, LOC);
});

test('records removed while resolving are left alone', async () => {
  const change: any = { id: 's1', timestamp: 1 };
  const styleChanges: any[] = [];
  const { attachSourceLocation } = loadAttach(styleChanges, [], [], () => Promise.resolve(LOC), () => {});
  await attachSourceLocation(el, change, () => assert.fail('must not re-sync a dropped record'));
  assert.equal('sourceLocation' in change, false);
});

test('every producer wires the attach without delaying its send', () => {
  const source = readFileSync(new URL('./change-tracker.ts', import.meta.url), 'utf8');
  for (const wire of [
    'void attachSourceLocation(el, merged, syncChange);',
    'void attachSourceLocation(el, change, syncChange);',
    'void attachSourceLocation(el, merged, syncTextChange);',
    'void attachSourceLocation(el, change, syncTextChange);',
    'void attachSourceLocation(recordedEl, change, syncDomChange);',
  ]) {
    assert.ok(source.includes(wire), `missing producer wiring: ${wire}`);
  }
  assert.ok(source.match(/void attachSourceLocation\(el, merged, syncTextChange\);/g)!.length >= 2,
    'text merges (textContent + rich text) both re-attach');
});

test('imported and replayed sessions tolerate records with or without sourceLocation', () => {
  Object.assign(globalThis, { document: { createDocumentFragment: () => ({ querySelector: () => null }) } });
  const payload = {
    styleChanges: [{ id: 'style-1', elementId: 'dm-1', selector: '#hero', property: 'color', oldValue: 'black', newValue: 'red', timestamp: 1, sourceLocation: LOC }],
    textChanges: [{ id: 'text-1', elementId: 'dm-1', selector: '#hero', oldText: 'a', newText: 'b', timestamp: 1 }],
    domChanges: [{ id: 'dom-1', elementId: 'dm-2', selector: '.card', action: 'move', tagName: 'div', timestamp: 1, origin: { parentSelector: 'body', index: 0 } }],
  };
  const parsed = validateImportPayload(structuredClone(payload));
  assert.deepEqual(parsed.styleChanges[0].sourceLocation, LOC, 'known locations survive the import boundary');
  assert.equal('sourceLocation' in parsed.textChanges[0], false);
  assert.equal('sourceLocation' in parsed.domChanges[0], false);
  const bare = validateImportPayload({ ...structuredClone(payload), styleChanges: [{ ...payload.styleChanges[0], id: 'style-2' }] });
  delete (bare.styleChanges[0] as any).sourceLocation;
  assert.doesNotMatch(JSON.stringify(bare), /"sourceLocation":null/, 'no null locations enter storage');
});
