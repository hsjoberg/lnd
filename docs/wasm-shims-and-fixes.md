# WASM Shims And Fixes

This is a summary of the main shims, runtime fixes, storage fixes, transport
hooks, and tooling fixes made during the browser `js/wasm` work and related
`mobile-rpc` fixes.

For a focused explanation of the current OPFS and `bbolt` stack, see
[wasm-storage-and-bbolt.md](./wasm-storage-and-bbolt.md).

## Shims

- Browser filesystem shim for the Go wasm runtime:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
- Two selectable runtime filesystem backends behind `globalThis.fs`:
  `memory` and `opfs`:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
- Browser stdout/stderr capture shim so Go and `lnd` logs appear in the page:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js),
  [wasm/demo/src/App.tsx](../wasm/demo/src/App.tsx)
- WebSocket-backed `tor.Net` and `net.Conn` transport shim for outbound
  Lightning and Bitcoin peer transport in wasm:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- Wasm host ABI entrypoint that reuses the shared `mobile.Start(...)` flow:
  [wasm/main.go](../wasm/main.go),
  [wasm/backend/start.go](../wasm/backend/start.go)
- Wasm `bbolt` mmap, locking, and write-through support now lives in the
  external fork `github.com/hsjoberg/bbolt-wasm` tagged `v1.4.3-wasm.1`

## Runtime And Boot Fixes

- Reuse `mobile.Start(...)` and `LoadConfig()` in wasm instead of maintaining a
  separate handwritten startup path:
  [mobile/bindings.go](../mobile/bindings.go),
  [wasm/backend/start.go](../wasm/backend/start.go)
- Skip TLS cert generation and use insecure in-proc creds in embedded wasm
  mode for the in-memory gRPC bridge:
  [lnd.go](../lnd.go)
- Added a start hook so wasm can mutate the loaded config after `LoadConfig()`
  and before `lnd.Main(...)`:
  [mobile/bindings.go](../mobile/bindings.go)
- Added a tiny embedded-network setter so wasm can replace `cfg.net` with a
  WebSocket-backed implementation:
  [config_embedded.go](../config_embedded.go)
- Nil-safe handling in subserver config reflection paths:
  [subrpcserver_config.go](../subrpcserver_config.go)
- Ignore browser-unsupported mkdir and file assumptions in a few startup paths
  while moving to wasm:
  [fs_compat.go](../fs_compat.go),
  [config.go](../config.go),
  [config_builder.go](../config_builder.go)

## Storage Fixes

- Initial in-memory `walletdb` and kvdb fallback for wasm bootstrapping:
  [kvdb/memdb/memdb_js.go](../kvdb/memdb/memdb_js.go),
  [kvdb/backend_js.go](../kvdb/backend_js.go)
- Switched wasm from fake memdb persistence to real `walletdb/bdb` using the
  external `bbolt` fork:
  [kvdb/backend_js.go](../kvdb/backend_js.go),
  [go.mod](../go.mod)
- Restored missing `MkdirAll` behavior in the wasm bolt backend so database
  directories are created before first open:
  [kvdb/backend_js.go](../kvdb/backend_js.go)

## Bug Fixes Exposed By Real Storage

- Existing nil-safe bucket/create behavior mismatch in the early fake memdb
  path so shared `channel.db` bootstrap worked

## Transport Fixes

- WebSocket transport is installed by overriding `cfg.net`, which is the
  existing `tor.Net` abstraction used by peer dialing and Neutrino:
  [config.go](../config.go),
  [config_builder.go](../config_builder.go),
  [wasm/backend/start.go](../wasm/backend/start.go),
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- The transport no longer uses proprietary `*_websocket_url` config. In wasm,
  outbound peer addresses remain the real peer TCP addresses, and the browser
  transport derives the WebSocket proxy endpoint by adding `2000` to the port,
  for example `127.0.0.1:9735 -> ws://127.0.0.1:11735` and
  `127.0.0.1:19444 -> ws://127.0.0.1:21444`:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go),
  [wasm/demo/src/App.tsx](../wasm/demo/src/App.tsx)
- The same `+2000` routing rule now works for hostnames too, so
  `europe.blixtwallet.com:8333 -> ws://europe.blixtwallet.com:10333`:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- Hostname peers in wasm are resolved to stable synthetic `198.18.x.x`
  addresses so Neutrino and peer bookkeeping can still construct `net.TCPAddr`
  values without requiring real DNS in the browser. The actual browser socket
  still connects to the original hostname:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- WebSocket scheme selection is automatic:
  - page loaded over `http:` -> `ws://`
  - page loaded over `https:` -> `wss://`
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- Important: if the app itself is served over HTTPS, the WebSocket proxy must
  also be reachable over `wss://`. Browsers will generally block `ws://` from
  an HTTPS page as mixed active content.
- Literal IP lookup support in the wasm `tor.Net` implementation so Neutrino
  can connect to peers like `127.0.0.1:19444` without attempting DNS in the
  browser:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- WebSocket conn now reports real `*net.TCPAddr` values from `RemoteAddr()` and
  `LocalAddr()` instead of a custom address type, which fixes channel funding
  flows that persist peer addresses:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go),
  [graph/db/addr.go](../graph/db/addr.go)
- Added stream bridges for server-streaming and bidi-streaming RPCs in the wasm
  shell, currently exercised by `SubscribeState` and `ChannelAcceptor`:
  [wasm/backend/server_streams.go](../wasm/backend/server_streams.go),
  [wasm/backend/bidi_streams.go](../wasm/backend/bidi_streams.go),
  [wasm/runtime/index.ts](../wasm/runtime/index.ts)

## Proven Milestones

- Neutrino compact-filter header sync works over WebSocket transport against a
  Bitcoin Core peer bridged by `websockify`
- Neutrino sync also works against a remote hostname-backed peer when the wasm
  transport maps the logical peer port to the WebSocket proxy port using the
  same `+2000` rule
- Lightning peer connection and brontide handshake work over WebSocket
  transport against an `lnd` peer bridged by `websockify`
- Channel opening works with the wasm node as the responder after fixing the
  custom `net.Addr` serialization issue

## Demo Harness Fixes

- Vite demo syncs the canonical wasm build artifacts from `wasm/build`:
  [wasm/demo/scripts/sync-wasm-assets.mjs](../wasm/demo/scripts/sync-wasm-assets.mjs)
- Demo runtime loads OPFS-backed `globalThis.fs` before `wasm_exec.js`:
  [wasm/runtime/index.ts](../wasm/runtime/index.ts),
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
- Demo UI shows logs, elapsed time, and protobuf-based RPC flows:
  [wasm/demo/src/App.tsx](../wasm/demo/src/App.tsx)

## Build And Tooling Fixes

- Local replace for `go-flags` to avoid the wasm ioctl and TTY issue:
  [go.mod](../go.mod),
  [third_party/go-flags](../third_party/go-flags)
- Local replace for `kvdb` and later the external `bbolt` fork:
  [go.mod](../go.mod)
- `mobile-rpc` Docker bug fix so it always uses
  [lnrpc/Dockerfile](../lnrpc/Dockerfile)
  instead of accidentally building the repo-root Dockerfile:
  [lnrpc/gen_protos_docker.sh](../lnrpc/gen_protos_docker.sh)
- Git Bash and MSYS path fix in the same script so Docker gets proper Windows
  paths when `MSYS_NO_PATHCONV=1` is used:
  [lnrpc/gen_protos_docker.sh](../lnrpc/gen_protos_docker.sh)

## Consider Upstreaming

- `migration21` nil-bucket bug in close channel summary migration:
  [channeldb/migration21/migration.go](../channeldb/migration21/migration.go)
