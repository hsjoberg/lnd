//go:build js && wasm

package backend

import (
	"syscall/js"
)

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
			// Generated server-stream bindings do not return a cancellable handle.
			// For now "stop" only detaches the JS callbacks so the caller can
			// locally unsubscribe without tearing down the whole wasm runtime.
			rStream.Stop()
			return nil
		})
	})
}
