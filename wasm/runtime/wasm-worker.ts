/// <reference lib="webworker" />

import {
  createGlobalWasmBackend,
  type WasmRuntimeBackend,
} from "./wasm-runtime-core";
import type { RequestMessage, ResponseMessage } from "./worker-protocol";

// Worker host for the browser runtime. This file actually loads and runs the
// Go wasm backend off the UI thread, then forwards RPC results, stream events,
// and stdout back to the main thread.
const ASSET_ROOT = "/wasm";
const scriptLoads = new Map<string, Promise<void>>();

type StreamHandle =
  | { stop(): void }
  | { send(requestBytes: Uint8Array): void; stop(): void };

function postMessageToMain(message: ResponseMessage) {
  self.postMessage(message);
}

function loadScriptOnce(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) {
    return existing;
  }

  const pending = (async () => {
    // Workers cannot inject <script> tags, so we fetch the helper sources and
    // evaluate them into the worker global scope explicitly.
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`failed to load script: ${src}`);
    }

    const source = await response.text();
    const loader = new Function(`${source}\n//# sourceURL=${src}`);
    loader();
  })();

  scriptLoads.set(src, pending);
  return pending;
}

const backend: WasmRuntimeBackend = createGlobalWasmBackend(globalThis, {
  assetRoot: ASSET_ROOT,
  loadScriptOnce,
});

// Stdout is forwarded as ordinary worker messages so the UI log panel can
// behave the same in both runtime modes.
backend.attachStdoutListener((line) => {
  postMessageToMain({ type: "stdout", line });
});

const streams = new Map<number, StreamHandle>();

function respondSuccess(requestId: number, result?: unknown) {
  postMessageToMain({ type: "response", requestId, success: true, result });
}

function respondError(requestId: number, error: unknown) {
  postMessageToMain({
    type: "response",
    requestId,
    success: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

self.addEventListener("message", async (event: MessageEvent<RequestMessage>) => {
  const message = event.data;

  try {
    // The worker protocol stays intentionally small: request/response for
    // one-shot calls plus stream IDs for server/bidi RPC traffic.
    switch (message.type) {
      case "load":
        respondSuccess(
          message.requestId,
          await backend.loadWasmRuntime(message.fsBackend),
        );
        return;
      case "start":
        await backend.startWasm(message.extraArgs);
        respondSuccess(message.requestId);
        return;
      case "getStatus":
        respondSuccess(message.requestId, backend.getWasmStatus());
        return;
      case "invokeRpc":
        respondSuccess(
          message.requestId,
          await backend.invokeRpc(message.method, message.requestBytes),
        );
        return;
      case "openServerStream": {
        const handle = backend.openServerStream(
          message.method,
          message.requestBytes,
          (responseBytes) =>
            postMessageToMain({
              type: "streamData",
              streamId: message.streamId,
              responseBytes,
            }),
          (error) =>
            postMessageToMain({
              type: "streamError",
              streamId: message.streamId,
              error,
            }),
        );
        streams.set(message.streamId, handle);
        respondSuccess(message.requestId);
        return;
      }
      case "openBidiStream": {
        const handle = backend.openBidiStream(
          message.method,
          (responseBytes) =>
            postMessageToMain({
              type: "streamData",
              streamId: message.streamId,
              responseBytes,
            }),
          (error) =>
            postMessageToMain({
              type: "streamError",
              streamId: message.streamId,
              error,
            }),
        );
        streams.set(message.streamId, handle);
        respondSuccess(message.requestId);
        return;
      }
      case "streamSend": {
        const handle = streams.get(message.streamId);
        if (!handle || typeof handle !== "object" || !("send" in handle)) {
          throw new Error(`unknown bidi stream ${message.streamId}`);
        }

        handle.send(message.requestBytes);
        respondSuccess(message.requestId);
        return;
      }
      case "streamStop": {
        const handle = streams.get(message.streamId);
        if (handle) {
          handle.stop();
          streams.delete(message.streamId);
        }
        respondSuccess(message.requestId);
        return;
      }
    }
  } catch (error) {
    respondError(message.requestId, error);
  }
});
