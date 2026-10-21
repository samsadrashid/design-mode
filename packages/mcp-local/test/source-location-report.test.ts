import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { state, type DomChange, type StyleChange, type TextChange } from '../src/state.ts';
import { executeLocalTool } from '../src/tools.ts';

const loc = { file: 'src/views/App.tsx', line: 42, column: 7, component: 'App', framework: 'react' as const };

const styleWith = (id: string, withLoc: boolean): StyleChange => ({
  id, elementId: id, selector: 'h1', property: 'color', oldValue: 'black', newValue: 'red',
  timestamp: 1, ...(withLoc ? { sourceLocation: loc } : {}),
});

const textWith = (id: string, withLoc: boolean): TextChange => ({
  id, elementId: id, selector: 'h1', oldText: 'old', newText: 'new',
  timestamp: 1, ...(withLoc ? { sourceLocation: loc } : {}),
});

const domWith = (id: string, withLoc: boolean): DomChange => ({
  id, elementId: id, selector: 'h1', action: 'delete', tagName: 'H1',
  timestamp: 1, ...(withLoc ? { sourceLocation: loc } : {}),
});

async function getChangesJson() {
  const result = await executeLocalTool('get_changes', {});
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

beforeEach(() => state.clear());

test('get_changes passes sourceLocation through on style changes', async () => {
  state.addStyleChange(styleWith('s1', true));
  const report = await getChangesJson();
  assert.deepEqual(report.styleChanges[0].sourceLocation, loc);
});

test('get_changes omits sourceLocation when unresolved', async () => {
  state.addStyleChange(styleWith('s2', false));
  const report = await getChangesJson();
  assert.equal('sourceLocation' in report.styleChanges[0], false);
});

test('get_changes passes sourceLocation through on text and dom changes', async () => {
  state.addTextChange(textWith('t1', true));
  state.addDomChange(domWith('d1', true));
  const report = await getChangesJson();
  assert.deepEqual(report.textChanges[0].sourceLocation, loc);
  assert.deepEqual(report.domChanges[0].sourceLocation, loc);
});

test('get_changes omits sourceLocation on unresolved text and dom changes', async () => {
  state.addTextChange(textWith('t2', false));
  state.addDomChange(domWith('d2', false));
  const report = await getChangesJson();
  assert.equal('sourceLocation' in report.textChanges[0], false);
  assert.equal('sourceLocation' in report.domChanges[0], false);
});

test('items carry sourceLocation only when resolved', async () => {
  state.addStyleChange(styleWith('s3', true));
  state.addStyleChange(styleWith('s4', false));
  state.addTextChange(textWith('t3', true));
  state.addDomChange(domWith('d3', false));
  const report = state.getFullChangeReport() as { items: Array<Record<string, unknown>> };
  const byId = new Map(report.items.map(i => [i.id as string, i]));
  assert.deepEqual(byId.get('s3')!.sourceLocation, loc);
  assert.equal('sourceLocation' in byId.get('s4')!, false);
  assert.deepEqual(byId.get('t3')!.sourceLocation, loc);
  assert.equal('sourceLocation' in byId.get('d3')!, false);
});

test('route group rows keep sourceLocation from the live arrays', async () => {
  const styleChanges = [styleWith('s5', true)];
  state.updateSession({
    pageUrl: 'https://example.test/a', pageTitle: 'A', cssBlock: '',
    styleChanges, textChanges: [], domChanges: [], comments: [],
    routeGroups: [{ routeKey: 'https://example.test/a', url: 'https://example.test/a', styleChanges, textChanges: [], domChanges: [], comments: [] }],
  });
  state.addStyleChange(styleWith('s5', true));
  const report = await getChangesJson();
  assert.deepEqual(report.routeGroups[0].styleChanges[0].sourceLocation, loc);
});

test('report JSON never contains a null sourceLocation', async () => {
  state.addStyleChange(styleWith('s6', true));
  state.addStyleChange(styleWith('s7', false));
  state.addTextChange(textWith('t4', false));
  state.addDomChange(domWith('d4', true));
  const report = await getChangesJson();
  assert.doesNotMatch(JSON.stringify(report), /"sourceLocation":null/);
});
