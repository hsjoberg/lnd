import type { FsBackend } from "./wasm-runtime-core";

// Shared message types for the Web Worker transport between the main-thread
// worker client and wasm-worker.ts. Keeping them here avoids protocol drift
// between the two sides of the runtime split.
export type RequestMessage =
  | { type: "load"; requestId: number; fsBackend: FsBackend }
  | { type: "setConsoleMirroring"; requestId: number; enabled: boolean }
  | { type: "start"; requestId: number; extraArgs: string }
  | { type: "getStatus"; requestId: number }
  | {
      type: "invokeRpc";
      requestId: number;
      method: string;
      requestBytes: Uint8Array;
    }
  | {
      type: "openServerStream";
      requestId: number;
      streamId: number;
      method: string;
      requestBytes: Uint8Array;
    }
  | {
      type: "openBidiStream";
      requestId: number;
      streamId: number;
      method: string;
    }
  | {
      type: "streamSend";
      requestId: number;
      streamId: number;
      requestBytes: Uint8Array;
    }
  | { type: "streamStop"; requestId: number; streamId: number };

export type ResponseMessage =
  | { type: "response"; requestId: number; success: true; result?: unknown }
  | { type: "response"; requestId: number; success: false; error: string }
  | { type: "streamData"; streamId: number; responseBytes: Uint8Array }
  | { type: "streamError"; streamId: number; error: string }
  | { type: "stdoutBatch"; lines: string[] }
  | { type: "stdout"; line: string };
