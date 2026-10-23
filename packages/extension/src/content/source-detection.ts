// ============================================================
// Phase 3: React/Framework Source Detection
// React fiber walking, _debugSource, stack trace probing,
// bundler URL stripping, click-to-open in VS Code
// ============================================================

import type { SourceLocation, ComponentHierarchy } from '@shared/types';
import { DATA_ATTR } from '@shared/constants';
import { resolveViaSourceMaps as resolveSourcemapHit, refineReactSourcePosition, type SourcemapHit } from './sourcemap-resolver';
import { sanitizeFiberSource } from './page-fiber-source';
import { whenSourcemapFetchSettingKnown } from './sourcemap-fetch-setting';

// ── React Fiber Tree Walking ──

function getFiberFromElement(el: HTMLElement): any {
  // React stores fiber on DOM nodes with keys starting with __reactFiber$ or __reactInternalInstance$
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (el as any)[key];
    }
  }
  return null;
}

function findDebugSource(fiber: any): { fileName: string; lineNumber: number; columnNumber?: number } | null {
  let cur = fiber;
  const visited = new Set();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    if (cur._debugSource) return cur._debugSource;
    // Check element type for source
    if (cur.type && cur.type.__source) return cur.type.__source;
    cur = cur.return;
  }
  return null;
}

function getComponentName(fiber: any): string | null {
  if (!fiber || !fiber.type) return null;
  if (typeof fiber.type === 'string') return null; // HTML elements
  return fiber.type.displayName || fiber.type.name || null;
}

// ── Component Hierarchy ──

export function getComponentHierarchy(el: HTMLElement): ComponentHierarchy[] {
  const hierarchy: ComponentHierarchy[] = [];
  const fiber = getFiberFromElement(el);
  if (!fiber) return hierarchy;

  let cur = fiber;
  const visited = new Set();
  while (cur && !visited.has(cur) && hierarchy.length < 15) {
    visited.add(cur);
    const name = getComponentName(cur);
    if (name) {
      const source = cur._debugSource ? {
        file: cleanSourcePath(cur._debugSource.fileName),
        line: cur._debugSource.lineNumber,
        column: cur._debugSource.columnNumber,
        component: name,
        framework: 'react' as const,
        bundlerUrl: cur._debugSource.fileName,
        cleanPath: cleanSourcePath(cur._debugSource.fileName),
      } : undefined;

      const props: Record<string, string> = {};
      if (cur.memoizedProps) {
        for (const [k, v] of Object.entries(cur.memoizedProps)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            props[k] = String(v);
          } else if (typeof v === 'function') {
            props[k] = `fn(${v.name || 'anonymous'})`;
          }
        }
      }

      hierarchy.push({ name, source, props: Object.keys(props).length > 0 ? props : undefined });
    }
    cur = cur.return;
  }

  return hierarchy;
}

// ── Source Location Detection ──

export function getSourceLocation(el: HTMLElement): SourceLocation | null {
  // Try React fiber first
  const fiber = getFiberFromElement(el);
  if (fiber) {
    const source = findDebugSource(fiber);
    const component = getComponentName(fiber);
    if (source) {
      return {
        file: source.fileName,
        line: source.lineNumber,
        column: source.columnNumber,
        component: component || undefined,
        framework: 'react',
        bundlerUrl: source.fileName,
        cleanPath: cleanSourcePath(source.fileName),
      };
    }
    if (component) {
      return {
        file: 'unknown',
        component,
        framework: 'react',
      };
    }
  }

  // Try Vue
  const vueSource = getVueSource(el);
  if (vueSource) return vueSource;

  // Try Angular
  const angularSource = getAngularSource(el);
  if (angularSource) return angularSource;

  // Try Svelte
  const svelteSource = getSvelteSource(el);
  if (svelteSource) return svelteSource;

  // Fallback: stack trace probing
  return probeSourceWalk(el);
}

// ── Vue Detection ──

function getVueSource(el: HTMLElement): SourceLocation | null {
  const vue = (el as any).__vue__ || (el as any).__vue_app__;
  if (!vue) {
    // Vue 3: check __vnode_context
    const vnode = (el as any).__vnode_context;
    if (vnode && vnode.type) {
      return {
        file: vnode.type.__file || 'unknown',
        component: vnode.type.__name || vnode.type.name,
        framework: 'vue',
        cleanPath: vnode.type.__file ? cleanSourcePath(vnode.type.__file) : undefined,
      };
    }
    return null;
  }
  const name = vue.$options?.name || vue.$options?.__file;
  if (!name) return null;
  return {
    file: vue.$options?.__file || 'unknown',
    component: vue.$options?.name || name,
    framework: 'vue',
    cleanPath: vue.$options?.__file ? cleanSourcePath(vue.$options.__file) : undefined,
  };
}

// ── Angular Detection ──

function getAngularSource(el: HTMLElement): SourceLocation | null {
  const ngContext = (el as any).__ngContext__;
  if (!ngContext) return null;
  // Try to extract component name from ng debug info
  const ngComponent = el.getAttribute('_nghost-') || el.getAttribute('ng-reflect-name');
  return {
    file: 'unknown',
    component: ngComponent || 'AngularComponent',
    framework: 'angular',
  };
}

// ── Svelte Detection ──

function getSvelteSource(el: HTMLElement): SourceLocation | null {
  // Svelte 4+ uses __svelte_meta
  const meta = (el as any).__svelte_meta;
  if (meta) {
    return {
      file: meta.loc?.file || 'unknown',
      line: meta.loc?.line,
      column: meta.loc?.column,
      framework: 'svelte',
      cleanPath: meta.loc?.file ? cleanSourcePath(meta.loc.file) : undefined,
    };
  }
  // Check for svelte context
  for (const key of Object.keys(el)) {
    if (key.startsWith('__svelte')) {
      return { file: 'unknown', framework: 'svelte' };
    }
  }
  return null;
}

// ── Stack Trace Probing (fallback) ──

function probeSourceWalk(el: HTMLElement): SourceLocation | null {
  try {
    // Try to get source from event handler if any
    const events = ['click', 'mouseenter', 'focus'];
    for (const evt of events) {
      const handler = (el as any)[`on${evt}`];
      if (handler && typeof handler === 'function') {
        const source = extractSourceFromFunction(handler);
        if (source) return source;
      }
    }

    // Try React __reactEvents
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactEvents$') || key.startsWith('__reactProps$')) {
        const props = (el as any)[key];
        if (props) {
          for (const [, v] of Object.entries(props)) {
            if (typeof v === 'function') {
              const source = extractSourceFromFunction(v as Function);
              if (source) return source;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

function extractSourceFromFunction(fn: Function): SourceLocation | null {
  try {
    const str = fn.toString();
    // Look for source map comment or file references
    const sourceMapMatch = str.match(/\/\/# sourceURL=(.+)/);
    if (sourceMapMatch) {
      return {
        file: sourceMapMatch[1],
        framework: 'unknown',
        cleanPath: cleanSourcePath(sourceMapMatch[1]),
      };
    }
  } catch {}
  return null;
}

// ── Source-Map Fallback ──

// Map positions are 0-based; SourceLocation keeps the 1-based
// convention used by React _debugSource and Svelte loc.
export function toSourceLocation(hit: SourcemapHit): SourceLocation {
  const clean = cleanSourcePath(hit.file);
  return {
    file: hit.file,
    line: hit.line + 1,
    column: hit.column + 1,
    ...(hit.component ? { component: hit.component } : {}),
    framework: 'unknown',
    cleanPath: clean,
  };
}

export async function resolveViaSourceMaps(el: HTMLElement): Promise<SourceLocation | null> {
  // Wait for the saved setting before deciding: no fetch may start on the
  // load-time guess that the gate is on.
  if (!(await whenSourcemapFetchSettingKnown())) return null;
  const hit = await resolveSourcemapHit(el);
  if (!hit) return null;
  return toSourceLocation(hit);
}

export async function resolveSourceLocation(el: HTMLElement): Promise<SourceLocation | null> {
  const direct = await getSourceLocation(el)
    ?? await mainWorldFiberSource(el);
  if (direct) return await refineReactLine(direct);
  return await resolveViaSourceMaps(el);
}

// ── React Dev Report Refinement ──

// React dev-only _debugSource lines are positions inside the bundler's
// intermediate module (the react-refresh preamble shifts every JSX line past
// where the authored file ends). When the served module publishes a source
// map, refine the report to the authored position; if anything is missing,
// keep the raw report — never a guessed correction.
async function refineReactLine(hit: SourceLocation): Promise<SourceLocation> {
  if (hit.framework !== 'react' || typeof hit.line !== 'number' || !hit.file || hit.file === 'unknown') return hit;
  // Same readiness gate as the CSS path: the first refinement after load
  // must wait for the saved setting too.
  if (!(await whenSourcemapFetchSettingKnown())) return hit;
  try {
    const pageOrigin = typeof location !== 'undefined' ? location.origin : undefined;
    const moduleUrl = findSameOriginModuleUrl(hit.file, pageOrigin);
    if (!moduleUrl) return hit;
    const pos = await refineReactSourcePosition(
      { file: hit.file, line: hit.line, ...(hit.column != null ? { column: hit.column } : {}) },
      { moduleUrl, pageOrigin },
    );
    if (!pos) return hit;
    // The mapped source must be the reported file; otherwise the module's
    // map describes a different unit and the refinement would misattribute.
    const mapped = cleanSourcePath(pos.file).replace(/^\/+/, '');
    const reported = cleanSourcePath(hit.file).replace(/^\/+/, '');
    if (!mapped || (!reported.endsWith(mapped) && !mapped.endsWith(reported))) return hit;
    return {
      ...hit,
      line: pos.line + 1,
      column: pos.column + 1,
    };
  } catch {
    return hit;
  }
}

// Locate the served module URL for an absolute authored path reported by a
// framework, using only resources the page itself loaded. Cross-origin and
// non-http candidates are dropped: the reported path is page-supplied and
// must never pick a fetch target by itself.
export function findSameOriginModuleUrl(reportedFile: string, pageOrigin?: string): string | null {
  const origin = pageOrigin ?? (typeof location !== 'undefined' ? location.origin : undefined);
  if (!origin || !reportedFile || /[\r\n\u0000-\u001f]/.test(reportedFile)) return null;
  const reported = reportedFile.replace(/\\/g, '/');
  let best: string | null = null;
  let bestLen = -1;
  const consider = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin !== origin) return;
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch { /* keep the raw pathname */ }
    if (path === '/') return;
    const fsPath = path.replace(/^\/@fs/, '');
    if (!reported.endsWith(path) && !fsPath.endsWith(reported)) return;
    if (path.length <= bestLen) return;
    best = url.toString();
    bestLen = path.length;
  };
  if (typeof performance !== 'undefined') {
    for (const entry of performance.getEntriesByType?.('resource') ?? []) {
      consider(entry.name);
    }
  }
  if (typeof document !== 'undefined') {
    for (const script of Array.from(document.querySelectorAll('script[src]'))) {
      consider(script.getAttribute('src'));
    }
  }
  return best;
}

// React fiber expandos (__reactFiber$…) live in the page world and are
// invisible from this isolated world, so the lookup hops through a
// MAIN-world executeScript. Best-effort: any failure just yields null and
// the sourcemap fallback runs next.
async function mainWorldFiberSource(el: HTMLElement): Promise<SourceLocation | null> {
  const id = el.getAttribute?.(DATA_ATTR);
  if (!id) return null;
  try {
    const hit = sanitizeFiberSource(await browser.runtime.sendMessage({ type: 'GET_FIBER_SOURCE', elementId: id }));
    if (!hit) return null;
    return {
      file: hit.file,
      line: hit.line,
      ...(hit.column !== undefined ? { column: hit.column } : {}),
      ...(hit.component ? { component: hit.component } : {}),
      framework: 'react',
      bundlerUrl: hit.file,
      cleanPath: cleanSourcePath(hit.file),
    };
  } catch {
    return null;
  }
}

// ── Bundler URL Stripping ──

export function cleanSourcePath(path: string): string {
  if (!path) return path;
  return path
    // Webpack
    .replace(/^webpack(-internal)?:\/\/\/.\//g, '')
    .replace(/^webpack:\/\/\/.\//g, '')
    .replace(/^webpack:\/\/[^/]+\//g, '')
    // Vite
    .replace(/^\/@fs\//g, '/')
    .replace(/^\/@id\//g, '')
    .replace(/\?v=[a-f0-9]+$/g, '')
    .replace(/\?t=\d+$/g, '')
    // Turbopack
    .replace(/^\[project\]\//g, '')
    // Generic
    .replace(/\?.*$/, '')
    .replace(/^\.\//, '');
}

// ── Click-to-Open in VS Code ──

export function openInVSCode(source: SourceLocation): void {
  if (!source.file || source.file === 'unknown') return;
  const path = source.cleanPath || cleanSourcePath(source.file);
  const line = source.line || 1;
  const col = source.column || 1;
  // Use VS Code URL handler
  const url = `vscode://file/${path}:${line}:${col}`;
  window.open(url, '_blank');
}

// ── Format for MCP Output ──

export function formatSourceLocation(source: SourceLocation): string {
  const parts: string[] = [];
  if (source.component) parts.push(`Component: ${source.component}`);
  parts.push(`File: ${source.cleanPath || source.file}`);
  if (source.line) parts.push(`Line: ${source.line}${source.column ? `:${source.column}` : ''}`);
  parts.push(`Framework: ${source.framework}`);
  return parts.join('\n');
}
