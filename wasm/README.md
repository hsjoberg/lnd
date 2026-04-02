# wasm

This directory contains the browser wasm stack for `lnd`.

The current structure is split into three layers:

## 1. `wasm/backend`

Go-side bridge code that is compiled into `lndmobile.wasm`.

This layer is responsible for:

- exposing the `lndWasm*` functions
- bridging into the generated `mobile/` bindings
- installing the wasm-specific startup hook
- providing the WebSocket-backed `tor.Net`
- generated unary/server-stream/bidi-stream RPC registries

In short: this is the Go backend that lives inside the wasm binary.

## 2. `wasm/runtime`

Browser-side glue for talking to the wasm backend.

This layer is responsible for:

- loading `fs_backends.js`
- loading `wasm_exec.js`
- instantiating `lndmobile.wasm`
- exposing a low-level byte-oriented runtime API
- supporting both:
  - main-thread execution
  - Web Worker execution
- forwarding stdout/log lines back to the caller

This layer intentionally stays low-level:

- raw unary bytes in/out
- raw server-stream bytes
- raw bidi-stream bytes
- no protobuf schema knowledge

That keeps the boundary simple: consumers of `wasm/runtime` can decide for
themselves how they want to encode and decode protobuf messages above the raw
byte transport.

## 3. `wasm/demo`

Example client application.

This layer is responsible for:

- UI
- protobuf request/response encoding and decoding
- testing/demo workflows
- serving copied wasm assets from `public/wasm`

The demo consumes `wasm/runtime`; it does not own the runtime logic itself.

## Entry Points

- [main.go](./main.go)
  - tiny top-level Go wasm entrypoint
- [backend](./backend)
  - Go wasm backend
- [runtime](./runtime)
  - browser runtime layer
- [demo](./demo)
  - example app

## Asset Flow

The browser runtime owns:

- [runtime/fs_backends.js](./runtime/fs_backends.js)

The demo serves copied assets from:

- `wasm/demo/public/wasm`

That copy step is handled by:

- [demo/scripts/sync-wasm-assets.mjs](./demo/scripts/sync-wasm-assets.mjs)

So the source of truth lives under `wasm/runtime`, while the demo only serves
the copied assets.

## Runtime Notes

- The OPFS backend in [runtime/fs_backends.js](./runtime/fs_backends.js) does
  not currently have a metadata-only rename path. Its `rename()` implementation
  copies the source entry to the destination and then deletes the source.
- That means renaming large files or directory trees in wasm can be much more
  expensive than on native filesystems, where rename is often effectively
  constant-time.
- Stdout from the wasm runtime is still forwarded back through the runtime/app
  log pipeline, but it is not mirrored to the browser console by default.
- Console mirroring can be re-enabled by setting
  `globalThis.__lndWasmMirrorStdoutToConsole = true` before loading the runtime.
- The worker OPFS backend will use `FileSystemSyncAccessHandle` when available.
- That can be disabled for testing by setting
  `globalThis.__lndWasmDisableOPFSSyncAccess = true` before loading the runtime.
