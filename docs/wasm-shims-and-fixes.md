# WASM Shims And Fixes

This note describes the current browser wasm architecture only. It focuses on
the shims and small `lnd`-side seams that still matter.

For the storage-specific details, see
[wasm-storage-and-bbolt.md](./wasm-storage-and-bbolt.md).

## Runtime Shims

- Browser filesystem shim for the Go wasm runtime:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
- This branch currently uses a `go-flags` replace to a wasm-compatible fork so
  config parsing does not try to use the terminal ioctl path on `js/wasm`:
  [go.mod](../go.mod)
- Two selectable runtime filesystem backends behind `globalThis.fs`:
  `memory` and `opfs`:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
- Browser stdout/stderr capture so Go and `lnd` logs appear in the page:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js),
  [wasm/demo/src/App.tsx](../wasm/demo/src/App.tsx)
- Wasm host ABI entrypoint that exposes the `lndWasm*` globals:
  [wasm/main.go](../wasm/main.go),
  [wasm/backend](../wasm/backend)
- Browser runtime layer that loads wasm assets and offers both main-thread and
  Web Worker execution:
  [wasm/runtime](../wasm/runtime)
- The browser runtime returns an unsubscribe function for server streams so its
  JS API keeps a conventional subscribe/unsubscribe shape. Calling that
  unsubscribe only silences future JS callbacks; it does not cancel the
  underlying falafel/mobile server-stream binding yet because no real
  cancellation handle is exposed there today:
  [wasm/runtime/wasm-runtime-core.ts](../wasm/runtime/wasm-runtime-core.ts),
  [wasm/backend/server_streams.go](../wasm/backend/server_streams.go)
- The wasm embedding expects explicit startup args that disable unsupported
  inbound and bootstrap paths, for example `--nolisten --norest
  --nobootstrap`:
  [wasm/demo/src/App.tsx](../wasm/demo/src/App.tsx)
- The browser target does not aim to support generic public Bitcoin peer
  discovery. The intended deployment model is explicit ws-capable peers such
  as `--neutrino.connect=...`, with bootstrap disabled, rather than normal
  DNS-seeded public P2P discovery:
  [wasm/demo/src/App.tsx](../wasm/demo/src/App.tsx),
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)

## Transport Model

- Outbound Lightning and Bitcoin peer transport is implemented as a
  WebSocket-backed `tor.Net`:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- Wasm installs that transport by replacing `cfg.net` after `LoadConfig()`:
  [mobile/bindings.go](../mobile/bindings.go),
  [config_embedded.go](../config_embedded.go),
  [wasm/backend/start.go](../wasm/backend/start.go)
- Outbound peer addresses remain the real peer TCP addresses. The browser
  transport derives the WebSocket proxy endpoint by adding `2000` to the port,
  for example:
  - `127.0.0.1:9735 -> ws://127.0.0.1:11735`
  - `127.0.0.1:19444 -> ws://127.0.0.1:21444`
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- The same `+2000` rule also applies to hostnames, for example:
  - `europe.blixtwallet.com:8333 -> ws://europe.blixtwallet.com:10333`
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- Hostname peers are resolved to stable synthetic `198.18.x.x` addresses so
  Neutrino and peer bookkeeping can still construct `net.TCPAddr` values
  without doing real DNS resolution inside `lnd`. This placeholder path is
  only used for hostname peers; IP-literal peers keep their actual IP
  addresses. The actual browser socket still connects to the original hostname.
  We intentionally avoid an internal DNS lookup path in `lnd` here because
  doing that cleanly in `js/wasm` would require extra browser-specific DNS
  machinery that the transport layer does not otherwise need:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- WebSocket scheme selection is automatic:
  - page loaded over `http:` -> `ws://`
  - page loaded over `https:` -> `wss://`
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- If the app itself is served over HTTPS, the WebSocket proxy must also be
  reachable over `wss://`. Browsers will generally block `ws://` from an HTTPS
  page as mixed active content. _In practice that means the WebSocket endpoint
  needs to be exposed on a real domain with a valid TLS certificate_, whether
  TLS is terminated directly by the proxy or by a reverse proxy in front of it.
- WebSocket conn reports standard concrete address types from `RemoteAddr()`
  and `LocalAddr()` instead of a custom wasm-only address wrapper. IP-literal
  peers still surface `*net.TCPAddr`, while hostname peers surface
  `*lnwire.DNSAddress` so the originally dialed hostname can be preserved for
  display and reconnect fallback:
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go),
  [graph/db/addr.go](../graph/db/addr.go)

## Storage Model

- The browser `fs` shim is the source of truth for wasm file IO:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
- The old js-only `kvdb/backend_js.go` shim is gone. Wasm now builds through
  the shared bolt backend and compaction files instead:
  [kvdb/backend.go](../kvdb/backend.go),
  [kvdb/bolt_compact.go](../kvdb/bolt_compact.go)
- Real database files are stored through OPFS, including `wallet.db`,
  `channel.db`, and `neutrino.db`:
  [wasm-storage-and-bbolt.md](./wasm-storage-and-bbolt.md)
- The wasm build uses the external `bbolt` fork
  [`github.com/hsjoberg/bbolt-wasm`](https://github.com/hsjoberg/bbolt-wasm)
  tagged `v1.4.3-wasm.1`:
  [go.mod](../go.mod)
- Neutrino header flat files are handled as ordinary append-only files and are
  flushed correctly by the OPFS backend:
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)

## Remaining `lnd` Deltas

- `mobile.Start(...)` has a small post-`LoadConfig()` hook so wasm can mutate
  runtime-only config state without reimplementing startup:
  [mobile/bindings.go](../mobile/bindings.go),
  [wasm/backend/start.go](../wasm/backend/start.go)
- Wasm sets `SkipTLSForEmbedded` after `LoadConfig()` so the embedded in-proc
  admin transport does not pay the normal TLS manager setup path. Without this,
  wasm startup falls back to the regular TLS manager flow even though the
  embedded admin client/server path stays in-memory. In practice this also has
  a significant performance impact for the embedded wasm setup; restoring this
  flag brought the `GetInfo x 100` benchmark back down from roughly `660 ms` to
  roughly `145 ms`:
  [config.go](../config.go),
  [lnd.go](../lnd.go),
  [tls_embedded.go](../tls_embedded.go),
  [wasm/backend/start.go](../wasm/backend/start.go)
- `Config.net` remains internal to `lnd`, so wasm uses a narrow setter to
  replace it with the WebSocket-backed transport:
  [config_embedded.go](../config_embedded.go)
- The fee estimator keeps a small wasm-only implementation so fee lookups use
  the browser HTTP stack instead of the native custom dialer path. The native
  implementation builds a custom `http.Transport` and `net.Dialer`, which is
  fine on normal hosts but falls back to unsupported raw DNS/TCP behavior on
  `js/wasm`:
  [lnwallet/chainfee/sparse_fee_source_js_wasm.go](../lnwallet/chainfee/sparse_fee_source_js_wasm.go)
