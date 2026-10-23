import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { state, type StyleChange } from '../src/state.ts';
import { executeLocalTool } from '../src/tools.ts';

// Pins the count semantics that looked like an "undercount" in the run1–3
// E2E reports: get_session_summary counts live records, get_changes
// consolidates rows per selector+property and renders routeGroups as
// per-route views of the same arrays. The 3-vs-5 divergence in the reports
// was cross-instant (a page snapshot wholesale-replacing records between
// calls), not a same-scope count bug.
const A = 'https://example.test/a';
const B = 'https://example.test/b';

const style = (id: string, selector: string, pageUrl: string, newValue: string): StyleChange => ({
  id, elementId: id, selector, property: 'color', oldValue: 'black', newValue,
  timestamp: 1, pageUrl, routeKey: pageUrl, cssRule: `${selector} { color: ${newValue}; }`,
});

async function summaryTotals() {
  const result = await executeLocalTool('get_session_summary', {});
  assert.equal(result.isError, undefined);
  const text = result.content[0];
  assert.equal(text.type, 'text');
  if (text.type !== 'text') return null;
  return JSON.parse(text.text) as { totalStyleChanges: number };
}

beforeEach(() => state.clear());

test('summary counts records while get_changes consolidates rows per selector+property', async () => {
  state.replaceChanges({
    styleChanges: [
      style('el-1', '.btn', A, 'red'),
      style('el-2', '.btn', A, 'blue'),
    ],
  });
  const summary = await summaryTotals();
  assert.equal(summary?.totalStyleChanges, 2);
  const report: any = state.getFullChangeReport();
  // Same route + selector + property: one row, last write wins.
  assert.deepEqual(report.styleChanges.map((c: any) => [c.selector, c.property, c.newValue]), [
    ['.btn', 'color', 'blue'],
  ]);
});

test('route groups are per-route views, not extra records', async () => {
  const styleChanges = [style('a', 'h1', A, 'red'), style('b', 'h1', B, 'blue')];
  state.updateSession({
    pageUrl: A, pageTitle: 'A', cssBlock: '', styleChanges,
    textChanges: [], domChanges: [],
    routeGroups: [A, B].map((url, i) => ({
      url, routeKey: url, styleChanges: [styleChanges[i]], textChanges: [], domChanges: [], comments: [],
    })),
  });
  state.replaceChanges({ styleChanges });
  const summary = await summaryTotals();
  assert.equal(summary?.totalStyleChanges, 2);
  const report: any = state.getFullChangeReport();
  // Different routes never consolidate, and group rows partition the records.
  assert.equal(report.styleChanges.length, 2);
  assert.equal(report.routeGroups.reduce((n: number, g: any) => n + g.styleChanges.length, 0), 2);
});

test('a page snapshot wholesale-replaces records, so rows seen earlier in a session can leave', async () => {
  state.replaceChanges({
    styleChanges: [style('r1', '#a', A, 'red'), style('r2', '#b', A, 'red')],
  });
  const afterFirst = await summaryTotals();
  assert.equal(afterFirst?.totalStyleChanges, 2);
  // Page B's snapshot carries no record of page A's edits (different origin,
  // no route group for A) — the replace is the documented convergence path.
  state.replaceChanges({ styleChanges: [style('r3', '#c', B, 'red')] });
  const afterSecond = await summaryTotals();
  assert.equal(afterSecond?.totalStyleChanges, 1);
  const report: any = state.getFullChangeReport();
  assert.equal(report.styleChanges.length, 1);
  assert.deepEqual(report.styleChanges[0].newValue, 'red');
});
