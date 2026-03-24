export type FsBackend = "memory" | "opfs";
export type RuntimeMode = "direct" | "worker";

// Shared browser-runtime primitives used by both the direct and worker-backed
// modes. This file owns the low-level wasm loading and raw byte transport
// contract, without pulling in protobuf-specific concerns.
type GoRuntime = {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): void;
};

type WasmGlobal = typeof globalThis & {
  Go?: new () => GoRuntime;
  __lndWasmPrepareFS?: (mode: FsBackend) => Promise<{ mode: FsBackend }>;
  __lndWasmStdoutLines?: string[];
  __lndWasmOnStdoutLine?: ((line: string) => void) | null;
  lndWasmStart?: (
    extraArgs: string,
    onSuccess: () => void,
    onError: (error: string) => void,
  ) => string | null | undefined;
  lndWasmGetStatus?: () => number;
  lndWasmInvokeRPC?: (
    method: string,
    requestBytes: Uint8Array,
    onSuccess: (responseBytes: Uint8Array) => void,
    onError: (error: string) => void,
  ) => string | null | undefined;
  lndWasmOpenServerStream?: (
    method: string,
    requestBytes: Uint8Array,
    onResponse: (responseBytes: Uint8Array) => void,
    onError: (error: string) => void,
  ) =>
    | {
        stop: () => string | null | undefined;
      }
    | string
    | null
    | undefined;
  lndWasmOpenBidiStream?: (
    method: string,
    onResponse: (responseBytes: Uint8Array) => void,
    onError: (error: string) => void,
  ) =>
    | {
        send: (requestBytes: Uint8Array) => string | null | undefined;
        stop: () => string | null | undefined;
      }
    | string
    | null
    | undefined;
};

export type BidiStreamHandle = {
  send(requestBytes: Uint8Array): void;
  stop(): void;
};

export type UnsubscribeFromStream = () => void;

// Both runtime modes expose the same backend contract so the app can switch
// between main-thread and worker execution without forking its RPC logic.
export type WasmRuntimeBackend = {
  loadWasmRuntime(fsBackend: FsBackend): Promise<{ mode: FsBackend }>;
  attachStdoutListener(onLine: (line: string) => void): () => void;
  startWasm(extraArgs: string): Promise<void>;
  getWasmStatus(): number;
  invokeRpc(method: string, requestBytes: Uint8Array): Promise<Uint8Array>;
  openServerStream(
    method: string,
    requestBytes: Uint8Array,
    onResponse: (responseBytes: Uint8Array) => void,
    onError: (error: string) => void,
  ): UnsubscribeFromStream;
  openBidiStream(
    method: string,
    onResponse: (responseBytes: Uint8Array) => void,
    onError: (error: string) => void,
  ): BidiStreamHandle;
};

type GlobalBackendOptions = {
  assetRoot: string;
  loadScriptOnce: (src: string) => Promise<void>;
};

function callbackToPromise<T>(
  invoker: (
    resolve: (value: T) => void,
    reject: (reason: string | Error) => void,
  ) => string | null | undefined,
) {
  return new Promise<T>((resolve, reject) => {
    const immediate = invoker(
      (value) => resolve(value),
      (reason) =>
        reject(reason instanceof Error ? reason : new Error(String(reason))),
    );

    if (immediate) {
      reject(new Error(String(immediate)));
    }
  });
}

export function createGlobalWasmBackend(
  runtime: WasmGlobal,
  { assetRoot, loadScriptOnce }: GlobalBackendOptions,
): WasmRuntimeBackend {
  let loadedBackend: FsBackend | null = null;
  let wasmLoadPromise: Promise<{ mode: FsBackend }> | null = null;

  function ensureWasmLoaded() {
    if (!runtime.lndWasmStart || !runtime.lndWasmGetStatus || !runtime.lndWasmInvokeRPC) {
      throw new Error("wasm runtime is not loaded");
    }

    return runtime;
  }

  return {
    async loadWasmRuntime(fsBackend: FsBackend) {
      if (loadedBackend) {
        if (loadedBackend !== fsBackend) {
          throw new Error(
            `wasm runtime already loaded with ${loadedBackend}; refresh to switch backends`,
          );
        }

        return { mode: loadedBackend };
      }

      if (!wasmLoadPromise) {
        wasmLoadPromise = (async () => {
          // fs_backends.js populates the Node-style shims and stdout hooks that
          // the Go wasm runtime expects before wasm_exec.js starts.
          await loadScriptOnce(`${assetRoot}/fs_backends.js`);

          if (!runtime.__lndWasmPrepareFS) {
            throw new Error("fs bridge is unavailable");
          }

          const fsStatus = await runtime.__lndWasmPrepareFS(fsBackend);

          await loadScriptOnce(`${assetRoot}/wasm_exec.js`);

          if (!runtime.Go) {
            throw new Error("Go wasm runtime is unavailable");
          }

          const go = new runtime.Go();
          const response = await WebAssembly.instantiateStreaming(
            fetch(`${assetRoot}/lndmobile.wasm`),
            go.importObject,
          );

          go.run(response.instance);
          loadedBackend = fsStatus.mode;
          return fsStatus;
        })().catch((error) => {
          wasmLoadPromise = null;
          throw error;
        });
      }

      return wasmLoadPromise;
    },

    attachStdoutListener(onLine: (line: string) => void) {
      // Late subscribers should still see buffered output from before the UI or
      // worker listener attached.
      for (const line of runtime.__lndWasmStdoutLines ?? []) {
        onLine(line);
      }

      runtime.__lndWasmOnStdoutLine = onLine;

      return () => {
        if (runtime.__lndWasmOnStdoutLine === onLine) {
          runtime.__lndWasmOnStdoutLine = null;
        }
      };
    },

    async startWasm(extraArgs: string) {
      const loaded = ensureWasmLoaded();
      await callbackToPromise<void>((resolve, reject) =>
        loaded.lndWasmStart!(extraArgs, () => resolve(undefined), reject),
      );
    },

    getWasmStatus() {
      return ensureWasmLoaded().lndWasmGetStatus!();
    },

    async invokeRpc(method: string, requestBytes: Uint8Array) {
      const loaded = ensureWasmLoaded();
      return callbackToPromise<Uint8Array>((resolve, reject) =>
        loaded.lndWasmInvokeRPC!(method, requestBytes, resolve, reject),
      );
    },

    openServerStream(
      method: string,
      requestBytes: Uint8Array,
      onResponse: (responseBytes: Uint8Array) => void,
      onError: (error: string) => void,
    ): UnsubscribeFromStream {
      const loaded = ensureWasmLoaded();
      if (!loaded.lndWasmOpenServerStream) {
        throw new Error("server streams are not available");
      }

      const handle = loaded.lndWasmOpenServerStream(
        method,
        requestBytes,
        onResponse,
        onError,
      );
      if (typeof handle === "string" && handle) {
        throw new Error(handle);
      }
      if (!handle || typeof handle !== "object" || typeof handle.stop !== "function") {
        throw new Error(`invalid server stream handle for ${method}`);
      }

      return () => {
        void handle.stop();
      };
    },

    openBidiStream(
      method: string,
      onResponse: (responseBytes: Uint8Array) => void,
      onError: (error: string) => void,
    ) {
      const loaded = ensureWasmLoaded();
      if (!loaded.lndWasmOpenBidiStream) {
        throw new Error("bidi streams are not available");
      }

      const handle = loaded.lndWasmOpenBidiStream(method, onResponse, onError);
      if (typeof handle === "string" && handle) {
        throw new Error(handle);
      }
      if (
        !handle ||
        typeof handle !== "object" ||
        typeof handle.send !== "function" ||
        typeof handle.stop !== "function"
      ) {
        throw new Error(`invalid bidi stream handle for ${method}`);
      }

      return {
        send(requestBytes: Uint8Array) {
          const result = handle.send(requestBytes);
          if (result) {
            throw new Error(String(result));
          }
        },
        stop() {
          const result = handle.stop();
          if (result) {
            throw new Error(String(result));
          }
        },
      };
    },
  };
}
