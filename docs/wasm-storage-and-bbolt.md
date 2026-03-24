# WASM Storage And `bbolt`

This note explains how the browser wasm storage stack currently works, why
there is a wasm-adapted `bbolt` fork in use, and what parts are Go runtime behavior versus
our own shim layer.

## Short Version

- `lnd` still opens normal database files at normal paths like
  `/lnd/data/graph/testnet/channel.db`.
- In `js/wasm`, Go routes file operations through `globalThis.fs` from
  `wasm_exec.js`.
- We provide `globalThis.fs` in
  [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js), backed by either:
  - in-memory storage
  - OPFS
- The `.db` files stored in OPFS are real `bbolt` binaries.
- `go.etcd.io/bbolt` is replaced with the wasm-adapted fork
  `github.com/hsjoberg/bbolt-wasm` tagged `v1.4.3-wasm.1`.

## What Is Go, And What Is Ours

### Go runtime behavior

The Go `js/wasm` runtime expects a Node-like `fs` object on `globalThis`.
`wasm_exec.js` uses that object to implement Go `os` and syscall-style file
operations.

That means:

1. Go code calls `os.Open`, `os.Stat`, `os.MkdirAll`, `WriteAt`, and so on.
2. The `js/wasm` runtime turns those into calls against `globalThis.fs`.
3. The browser host must provide a compatible `fs` implementation.

### Our shim

We provide that `fs` implementation in
[wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js).

That shim provides two runtime backends:

- `memory`
- `opfs`

So:

- Go choosing to use `globalThis.fs` is Go runtime behavior.
- Implementing `globalThis.fs` for the browser is our shim.

## How `bbolt` Reaches OPFS

`bbolt` itself is not OPFS-aware.

The storage path is:

1. `lnd` opens a database file like `/lnd/data/.../channel.db`.
2. `bbolt` uses normal Go file APIs.
3. Go `js/wasm` routes those file operations to `globalThis.fs`.
4. Our OPFS backend in
   [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)
   maps those file operations to actual OPFS file handles.
5. The resulting files in OPFS are native-path `.db` files containing real
   `bbolt` binary pages.

This is why files like these now exist as real files in OPFS:

- `/lnd/data/graph/testnet/channel.db`
- `/lnd/data/chain/bitcoin/testnet/neutrino.db`
- `/lnd/data/chain/bitcoin/testnet/wallet.db`

And why header/log files also appear normally:

- `/lnd/data/chain/bitcoin/testnet/block_headers.bin`
- `/lnd/data/chain/bitcoin/testnet/reg_filter_headers.bin`
- `/lnd/logs/bitcoin/testnet/lnd.log`

One important detail for Neutrino is that these header flat files are not
stored inside `bbolt`. They are ordinary append-only files managed by
Neutrino `headerfs`.

## Why We Need A `bbolt` Fork

Upstream `bbolt` assumes host OS primitives that browser `js/wasm` does not
really provide:

- memory-mapped files
- file locking
- coherent mapped file views after writes

So some wasm-specific adaptation is required if we want real bolt semantics in
the browser.

The repo currently does that with a module replacement in [go.mod](../go.mod):

- `replace go.etcd.io/bbolt => github.com/hsjoberg/bbolt-wasm v1.4.3-wasm.1`

This is not a ground-up database rewrite. It is upstream `bbolt` plus a small
set of wasm-specific patches.

## Scope Of The Fork

The fork is relatively contained.

### Added wasm/helper files in the fork

- `bolt_js_wasm.go`
- `mlock_js_wasm.go`
- `writeat_js_wasm.go`
- `writeat_default.go`
- `internal/common/bolt_wasm.go`

### Touched upstream files in the fork

- `db.go`
- `bolt_unix.go`
- `boltsync_unix.go`
- `mlock_unix.go`

So the fork is roughly nine touched files total, with the real logic
concentrated in a few small areas.

## What The Fork Actually Changes

### 1. wasm mmap implementation

In `bolt_js_wasm.go`, `mmap()` is replaced with a browser-safe approximation:

- if needed, truncate the file
- read the file contents into a byte slice
- treat that byte slice as the mapped view

So the wasm build uses an in-memory snapshot instead of a real OS mmap.

### 2. file locking is stubbed

Also in `bolt_js_wasm.go`:

- `flock()` is a no-op
- `funlock()` is a no-op

That is acceptable for the current browser model because we are not dealing
with normal multi-process host locking semantics.

### 3. mlock is stubbed

In `mlock_js_wasm.go`:

- `mlock()` is a no-op
- `munlock()` is a no-op

### 4. wasm size constants

In `internal/common/bolt_wasm.go`, wasm-specific `MaxMapSize` and
`MaxAllocSize` constants are defined.

### 5. write-through coherence hook

This is the most important correctness fix.

Because wasm is not using a real mmap, writes to the file do not automatically
update the in-memory mapped view.

So in `db.go`, `Open()` installs a write hook:

- default path: `db.ops.writeAt = db.file.WriteAt`
- then `installWriteAtHook(db)`

In the wasm build, `writeat_js_wasm.go` wraps `WriteAt` so that after writing
to the file it also updates `db.dataref` for the written byte range.

Without that hook, `bbolt` can read stale pages after writes and corrupt its
internal view of the database.

That specific issue was the cause of the `page 3 already freed` panic that was
seen during startup.

## Performance Expectations

This should be treated as a correctness-first port.

What to expect:

- likely good enough for a PoC
- slower than native host `bbolt`
- acceptable for light/medium browser usage
- worth benchmarking on storage-heavy flows before making stronger claims

One important observation from the current wasm harness is that protobuf RPC
itself is cheap:

- `GetInfo x 100` around `150 ms`
- about `1.5 ms` per call

That does **not** measure `bbolt` performance directly, but it does show the
in-proc byte RPC path is not the bottleneck.

The more relevant storage benchmarks are:

- first start with fresh DBs
- second start with persisted DBs
- `InitWallet`
- `UnlockWallet`
- compare `memory` vs `opfs`

## Neutrino Persistence Note

Neutrino persists two different kinds of browser state:

- `neutrino.db` through `walletdb`
- header flat files such as:
  - `block_headers.bin`
  - `reg_filter_headers.bin`

The flat files are written by Neutrino `headerfs` using long-lived
append-only file descriptors. Our OPFS shim originally buffered file data in
memory until `fsync` or `close`. That worked for many normal files, but it
meant Neutrino header files could appear to restart from height `0` because
they were never explicitly closed during a normal runtime.

The current OPFS shim fixes that by treating append-opened files as
write-through:

- append-mode files still keep their in-memory copy
- but each write is also flushed to OPFS immediately

That behavior lives in:
- [wasm/runtime/fs_backends.js](../wasm/runtime/fs_backends.js)

This is a browser-only persistence fix. Native filesystem behavior is
unchanged.

## Fee Estimator Note

On mainnet with Neutrino, `lnd` requires a web fee estimator URL. The wasm path
needs a browser-compatible HTTP client there too.

Native `SparseConfFeeSource.GetFeeInfo()` uses a custom `http.Transport` and
`net.Dialer`, which is correct on normal hosts but breaks on `js/wasm` because
it falls back to unsupported raw DNS/TCP. The current implementation keeps the
native code path intact and adds a wasm-only version that uses the default
browser HTTP path instead:

- native:
  [sparse_fee_source_default.go](../lnwallet/chainfee/sparse_fee_source_default.go)
- wasm:
  [sparse_fee_source_js_wasm.go](../lnwallet/chainfee/sparse_fee_source_js_wasm.go)

## Could This Be Nicer?

Yes, but not dramatically simpler if the goal is to keep real bolt semantics.

The practical near-term strategy is:

- keep the fork small
- keep wasm-only code isolated
- document each patch clearly
- rebase on upstream when necessary

The realistic alternatives are:

- upstream the wasm support, if acceptable upstream
- replace bolt with another backend, which is a much larger project

For now, the small external fork is the pragmatic approach.

## Related Transport Note

The OPFS and `bbolt` work is only the storage side. Browser peer connectivity
uses a separate transport hook:

- `lnd` already routes peer dialing through `cfg.net`, which is a `tor.Net`
  abstraction
- wasm overrides `cfg.net` with a WebSocket-backed implementation in
  [wasm/backend/websocket_net.go](../wasm/backend/websocket_net.go)
- the hook is installed from [wasm/backend/start.go](../wasm/backend/start.go) using
  [config_embedded.go](../config_embedded.go)

That transport layer is what allows:

- Lightning peering over WebSocket
- Neutrino Bitcoin P2P over WebSocket

One subtle bug there was that the WebSocket conn originally returned a custom
`net.Addr` type. During channel funding, `lnd` persists peer addresses through
[graph/db/addr.go](../graph/db/addr.go), which only knows standard address
types like `*net.TCPAddr`. The fix was to make the WebSocket conn report real
TCP addresses from `RemoteAddr()` and `LocalAddr()`.
