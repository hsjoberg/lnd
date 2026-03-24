//go:build js && wasm

package backend

import "syscall/js"

// Raw unary RPC entrypoint for the browser runtime. It stays byte-oriented and
// delegates method lookup to the generated unary registry so callers can
// choose their own protobuf codec above this layer.

func registerUnaryAPI() {
	registerJSFunc("lndWasmInvokeRPC", func(_ js.Value, args []js.Value) any {
		if len(args) != 4 {
			return "lndWasmInvokeRPC expects method, requestBytes, successCb, errorCb"
		}
		if err := validateJSCallbacks("successCb", args[2], "errorCb", args[3]); err != nil {
			return err.Error()
		}

		req, err := bytesFromJS(args[1])
		if err != nil {
			return err.Error()
		}

		rpc, ok := unaryMethods[args[0].String()]
		if !ok {
			return "unknown rpc method"
		}

		rpc(req, &jsCallback{
			onResponse: args[2],
			onError:    args[3],
		})
		return nil
	})
}
