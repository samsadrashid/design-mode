import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourcemapFetchEnabled, applySourcemapFetchValue } from './sourcemap-fetch-setting.ts';

// The gate defaults to on, treats anything but an explicit stored false as
// on, and is shared mutable state — restore the default after every flip so
// order-dependent suites keep their baseline.
describe('sourcemap fetch setting', () => {
  it('defaults to enabled when no stored value exists', () => {
    assert.equal(sourcemapFetchEnabled(), true);
  });

  it('treats only an explicit false as off', () => {
    try {
      applySourcemapFetchValue(false);
      assert.equal(sourcemapFetchEnabled(), false);
      applySourcemapFetchValue(undefined);
      assert.equal(sourcemapFetchEnabled(), true);
      applySourcemapFetchValue(true);
      assert.equal(sourcemapFetchEnabled(), true);
    } finally {
      applySourcemapFetchValue(true);
    }
  });
});
