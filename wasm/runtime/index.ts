import { type FsBackend, type RuntimeMode } from "./wasm-runtime-core";
import { getDirectWasmBackend } from "./wasm-runtime-direct";
import { getWorkerWasmBackend } from "./wasm-runtime-worker";

// Public entrypoint for the browser runtime layer. This file picks the active
// runtime mode and exposes one stable API to the demo or any other caller.
let activeRuntimeMode: RuntimeMode | null = null;

function getBackend(mode: RuntimeMode) {
  if (mode === "worker") {
    return getWorkerWasmBackend();
  }

  return getDirectWasmBackend();
}

function getActiveBackend() {
  return getBackend(activeRuntimeMode ?? "direct");
}

export async function loadWasmRuntime(
  fsBackend: FsBackend,
  runtimeMode: RuntimeMode,
) {
  if (activeRuntimeMode && activeRuntimeMode !== runtimeMode) {
    throw new Error(
      `wasm runtime already loaded in ${activeRuntimeMode} mode; refresh to switch modes`,
    );
  }

  const backend = getBackend(runtimeMode);
  const result = await backend.loadWasmRuntime(fsBackend);
  // The Go runtime is effectively singleton-per-page, so once one mode is
  // loaded we force a refresh before allowing the other mode to take over.
  activeRuntimeMode = runtimeMode;
  return result;
}

export function attachStdoutListener(
  onLine: (line: string) => void,
  runtimeMode: RuntimeMode,
) {
  return getBackend(runtimeMode).attachStdoutListener(onLine);
}

export function startWasm(extraArgs: string) {
  return getActiveBackend().startWasm(extraArgs);
}

export function getWasmStatus() {
  return getActiveBackend().getWasmStatus();
}

export function invokeRpc(method: string, requestBytes: Uint8Array) {
  return getActiveBackend().invokeRpc(method, requestBytes);
}

export function openServerStream(
  method: string,
  requestBytes: Uint8Array,
  onResponse: (responseBytes: Uint8Array) => void,
  onError: (error: string) => void,
) {
  return getActiveBackend().openServerStream(
    method,
    requestBytes,
    onResponse,
    onError,
  );
}

export function openBidiStream(
  method: string,
  onResponse: (responseBytes: Uint8Array) => void,
  onError: (error: string) => void,
) {
  return getActiveBackend().openBidiStream(method, onResponse, onError);
}

export type { FsBackend, RuntimeMode };
