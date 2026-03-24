//go:build js && wasm

package backend

import (
	"syscall/js"
)

func registerBidiStreamAPI() {
	registerJSFunc("lndWasmOpenBidiStream", func(_ js.Value, args []js.Value) any {
		if len(args) != 3 {
			return "lndWasmOpenBidiStream expects method, successCb, errorCb"
		}
		if err := validateJSCallbacks("successCb", args[1], "errorCb", args[2]); err != nil {
			return err.Error()
		}

		openStream, ok := bidiStreamMethods[args[0].String()]
		if !ok {
			return "unknown bidi stream method"
		}

		rStream := &jsRecvStream{
			onResponse: args[1],
			onError:    args[2],
		}

		handle, err := openStream(rStream)
		if err != nil {
			return err.Error()
		}

		return newJSStreamHandle(handle.Send, func() error {
			// For bidi streams we do have a real generated SendStream handle, so we
			// stop local callbacks first and then close the underlying stream.
			rStream.Stop()
			return handle.Stop()
		})
	})
}
