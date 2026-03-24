//go:build js && wasm

package backend

import (
	"syscall/js"
)

// Server-streaming RPC bridge for the browser runtime. Generated mobile
// server-stream bindings do not return a cancellable handle yet, so wasm can
// only offer a local stop that silences future JS callbacks; it cannot cancel
// the underlying falafel stream today.

func registerServerStreamAPI() {
	registerJSFunc("lndWasmOpenServerStream", func(_ js.Value, args []js.Value) any {
		if len(args) != 4 {
			return "lndWasmOpenServerStream expects method, requestBytes, successCb, errorCb"
		}
		if err := validateJSCallbacks("successCb", args[2], "errorCb", args[3]); err != nil {
			return err.Error()
		}

		req, err := bytesFromJS(args[1])
		if err != nil {
			return err.Error()
		}

		rpc, ok := serverStreamMethods[args[0].String()]
		if !ok {
			return "unknown server stream method"
		}

		rStream := &jsRecvStream{
			onResponse: args[2],
			onError:    args[3],
		}

		rpc(req, rStream)
		return newJSStreamHandle(nil, func() error {
			rStream.Stop()
			return nil
		})
	})
}
