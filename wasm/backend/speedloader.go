//go:build js && wasm

package backend

import (
	"syscall/js"

	lndmobile "github.com/lightningnetwork/lnd/mobile"
)

// JS bridge for the mobile speedloader helper used by the wasm demo.
func registerSpeedloaderAPI() {
	registerJSFunc("lndWasmGossipSync", func(_ js.Value, args []js.Value) any {
		if len(args) != 5 {
			return "lndWasmGossipSync expects serviceUrl, cacheDir, dataDir, successCb, errorCb"
		}
		if err := validateJSCallbacks("successCb", args[3], "errorCb", args[4]); err != nil {
			return err.Error()
		}

		go lndmobile.GossipSync(
			args[0].String(),
			args[1].String(),
			args[2].String(),
			"wifi",
			&jsStringCallback{
				onResponse: args[3],
				onError:    args[4],
			},
		)

		return nil
	})

	registerJSFunc("lndWasmCancelGossipSync", func(_ js.Value, _ []js.Value) any {
		lndmobile.CancelGossipSync()
		return nil
	})
}
