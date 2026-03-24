import {
  type BidiStreamHandle,
  type UnsubscribeFromStream,
  type WasmRuntimeBackend,
} from "./wasm-runtime-core";
import type { FsBackend } from "./wasm-runtime-core";
import type { RequestMessage, ResponseMessage } from "./worker-protocol";

// Main-thread client for the worker-backed runtime. It mirrors the shared
// WasmRuntimeBackend interface locally and forwards all actual wasm execution to
// wasm-worker.ts over a small request/response + stream protocol.
type StreamCallbacks = {
  onResponse: (responseBytes: Uint8Array) => void;
  onError: (error: string) => void;
};

// The worker instance is long-lived because the Go wasm runtime is not designed
// to be torn down and recreated repeatedly within a single page session.
let workerInstance: Worker | null = null;
let nextRequestId = 1;
let nextStreamId = 1;
let cachedStatus = 0;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();
const streamCallbacks = new Map<number, StreamCallbacks>();
const stdoutListeners = new Set<(line: string) => void>();
const stdoutLines: string[] = [];

function requestTransferables(message: RequestMessage): Transferable[] {
  switch (message.type) {
    case "invokeRpc":
    case "openServerStream":
    case "streamSend":
      return [message.requestBytes.buffer];
    default:
      return [];
  }
}

function getWorker() {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL("./wasm-worker.ts", import.meta.url),
      { type: "module" },
    );

    workerInstance.addEventListener("message", (event: MessageEvent<ResponseMessage>) => {
      const message = event.data;

      switch (message.type) {
        case "response": {
          const entry = pending.get(message.requestId);
          if (!entry) {
            return;
          }

          pending.delete(message.requestId);
          if (message.success) {
            entry.resolve(message.result);
          } else {
            entry.reject(new Error(message.error));
          }
          return;
        }
        case "streamData": {
          streamCallbacks.get(message.streamId)?.onResponse(message.responseBytes);
          return;
        }
        case "streamError": {
          streamCallbacks.get(message.streamId)?.onError(message.error);
          return;
        }
        case "stdout":
          stdoutLines.push(message.line);
          if (stdoutLines.length > 500) {
            stdoutLines.shift();
          }
          for (const listener of stdoutListeners) {
            listener(message.line);
          }
      }
    });
  }

  return workerInstance;
}

function sendRequest<T>(message: RequestMessage): Promise<T> {
  const requestId = nextRequestId++;
  const worker = getWorker();

  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    worker.postMessage(
      { ...message, requestId },
      requestTransferables(message),
    );
  });
}

export function getWorkerWasmBackend(): WasmRuntimeBackend {
  return {
    loadWasmRuntime(fsBackend) {
      return sendRequest<{ mode: FsBackend }>({
        type: "load",
        requestId: 0,
        fsBackend,
      }).then(
        (result) => {
          cachedStatus = 0;
          return result;
        },
      );
    },

    attachStdoutListener(onLine) {
      for (const line of stdoutLines) {
        onLine(line);
      }

      stdoutListeners.add(onLine);
      return () => {
        stdoutListeners.delete(onLine);
      };
    },

    async startWasm(extraArgs) {
      await sendRequest<void>({ type: "start", requestId: 0, extraArgs });
      cachedStatus = 1;
    },

    getWasmStatus() {
      // The shared app code expects a synchronous status getter. In worker mode
      // we keep a small local mirror of start/stop state instead of adding a
      // dedicated round-trip for every status read.
      return cachedStatus;
    },

    async invokeRpc(method, requestBytes) {
      const response = await sendRequest<Uint8Array>({
        type: "invokeRpc",
        requestId: 0,
        method,
        requestBytes,
      });
      if (method === "StopDaemon") {
        cachedStatus = 0;
      }
      return response;
    },

    openServerStream(
      method,
      requestBytes,
      onResponse,
      onError,
    ): UnsubscribeFromStream {
      const streamId = nextStreamId++;
      streamCallbacks.set(streamId, { onResponse, onError });

      void sendRequest<void>({
        type: "openServerStream",
        requestId: 0,
        streamId,
        method,
        requestBytes,
      }).catch((error) => {
        streamCallbacks.delete(streamId);
        onError(error instanceof Error ? error.message : String(error));
      });

      return () => {
        streamCallbacks.delete(streamId);
        void sendRequest<void>({
          type: "streamStop",
          requestId: 0,
          streamId,
        });
      };
    },

    openBidiStream(method, onResponse, onError): BidiStreamHandle {
      const streamId = nextStreamId++;
      streamCallbacks.set(streamId, { onResponse, onError });

      // Same pattern as server streams: return a synchronous handle, then bind
      // it to the real worker-side stream once the open request completes.
      const ready = sendRequest<void>({
        type: "openBidiStream",
        requestId: 0,
        streamId,
        method,
      }).catch((error) => {
        streamCallbacks.delete(streamId);
        onError(error instanceof Error ? error.message : String(error));
      });

      return {
        send(requestBytes) {
          void ready.then(() =>
            sendRequest<void>({
              type: "streamSend",
              requestId: 0,
              streamId,
              requestBytes,
            }).catch((error) => {
              onError(error instanceof Error ? error.message : String(error));
            }),
          );
        },
        stop() {
          void ready.finally(() => {
            streamCallbacks.delete(streamId);
            void sendRequest<void>({
              type: "streamStop",
              requestId: 0,
              streamId,
            });
          });
        },
      };
    },
  };
}
