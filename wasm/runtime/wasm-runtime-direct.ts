import {
  createGlobalWasmBackend,
  type WasmRuntimeBackend,
} from "./wasm-runtime-core";

// Main-thread runtime implementation. It loads the browser wasm assets
// directly into the page and calls the exported lndWasm* globals without a
// worker hop.
const ASSET_ROOT = "/wasm";
const scriptLoads = new Map<string, Promise<void>>();

function loadScriptOnce(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) {
    return existing;
  }

  const pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load script: ${src}`));
    document.head.appendChild(script);
  });

  scriptLoads.set(src, pending);
  return pending;
}

let directBackend: WasmRuntimeBackend | null = null;

export function getDirectWasmBackend(): WasmRuntimeBackend {
  if (!directBackend) {
    // Direct mode keeps the current simplest setup: wasm_exec.js and the
    // lnd globals live on the page thread, so debugging stays straightforward.
    directBackend = createGlobalWasmBackend(globalThis, {
      assetRoot: ASSET_ROOT,
      loadScriptOnce,
    });
  }

  return directBackend;
}
