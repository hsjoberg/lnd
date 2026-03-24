# lnd wasm demo

Vite-based browser harness for the `./wasm` entrypoint.

Typical workflow:

```bash
MSYS_NO_PATHCONV=1 make wasm
cd wasm/demo
npm install
npm run dev
```

The app uses:

- `react-native-turbo-lnd` protobuf schemas for request/response types
- `@bufbuild/protobuf` for binary encode/decode
- `lndWasmInvokeRPC(...)` for byte-based RPC transport

Peer connection details are entered directly in the UI as `pubkey@host:port`.

For browser peer transport, configure the real peer TCP ports. The wasm
transport adds `2000` internally to derive the WebSocket proxy port. For
example:

- Lightning peer via `websockify`: `127.0.0.1:9735` -> `ws://127.0.0.1:11735`
- Bitcoin Neutrino peer via `websockify`: `127.0.0.1:19444` -> `ws://127.0.0.1:21444`

The same rule also works for hostnames:

- `europe.blixtwallet.com:8333` -> `ws://europe.blixtwallet.com:10333`

Scheme selection is automatic:

- app loaded over `http:` -> `ws://`
- app loaded over `https:` -> `wss://`

So a hosted HTTPS page will automatically attempt secure WebSockets.
That also means your WebSocket proxy must be available over `wss://` when the
app is served over HTTPS, otherwise the browser will block the connection as
mixed content.

The sync script copies the canonical wasm build artifacts from `wasm/build` into
`public/wasm`. It does not build wasm itself, so run `make wasm` first.
