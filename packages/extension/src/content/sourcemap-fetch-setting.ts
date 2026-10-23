// ============================================================
// User gate for the source-map resolution fetches
// (chrome.storage.local key `dm-sourcemap-fetch`). The fetches are
// same-origin reads of resources the page already loaded, so the
// default stays on, but they remain outbound calls the user can
// switch off. Cached at module scope and refreshed via
// storage.onChanged so resolution never awaits a storage read.
// ============================================================

const STORAGE_KEY = 'dm-sourcemap-fetch';

let enabled = true;

export function sourcemapFetchEnabled(): boolean {
  return enabled;
}

// Anything but an explicit stored false keeps the documented default;
// shared by the storage listeners and the tests.
export function applySourcemapFetchValue(value: unknown): void {
  enabled = value !== false;
}

try {
  browser.storage?.local?.get?.([STORAGE_KEY])?.then((r: Record<string, unknown>) => {
    applySourcemapFetchValue(r?.[STORAGE_KEY]);
  });
  browser.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) applySourcemapFetchValue(changes[STORAGE_KEY].newValue);
  });
} catch {
  // No extension storage in this context (tests, SSR) — default stays on.
}
