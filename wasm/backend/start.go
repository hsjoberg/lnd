//go:build js && wasm

package backend

import (
	"syscall/js"

	"github.com/lightningnetwork/lnd"
	lndmobile "github.com/lightningnetwork/lnd/mobile"
)

// Wires wasm startup into the shared mobile.Start(...) path. The wasm-specific
// startup work is limited to installing the WebSocket-backed network transport
// after LoadConfig() has built the normal lnd config.

func setStartHook() {
	lndmobile.SetStartConfigHook(func(loaded *lnd.Config) error {
		// The embedded admin client/server path stays in-memory in wasm, so
		// we skip the normal TLS manager setup to avoid paying that startup
		// cost for an in-proc transport.
		loaded.SkipTLSForEmbedded = true

		// Replace the runtime dialer after LoadConfig so Lightning peer traffic
		// and Neutrino peer traffic both use the wasm WebSocket transport.
		lnd.SetEmbeddedNet(loaded, newWebsocketNet())
		return nil
	})
}

func getStatus() int32 {
	cb := &statusCallback{}
	lndmobile.ServiceStatus(cb)
	return cb.value
}

func registerStartAPI() {
	registerJSFunc("lndWasmStart", func(_ js.Value, args []js.Value) any {
		if len(args) != 3 {
			return "lndWasmStart expects extraArgs, success callback, and error callback"
		}
		if err := validateJSCallbacks("successCb", args[1], "errorCb", args[2]); err != nil {
			return err.Error()
		}

		setStartHook()
		go lndmobile.Start(args[0].String(), &jsCallback{
			onResponse: args[1],
			onError:    args[2],
		})
		return nil
	})

	registerJSFunc("lndWasmGetStatus", func(_ js.Value, _ []js.Value) any {
		return getStatus()
	})
}
