//go:build js && wasm

package backend

import (
	"sync"
	"syscall/js"
)

// Top-level JS ABI for the Go wasm backend. It registers the exported JS
// functions, retains js.Func values for the lifetime of the runtime, and keeps
// the Go wasm program alive after startup.

var (
	jsFuncs           []js.Func
	streamJSFuncsMu   sync.Mutex
	streamJSFuncs     = make(map[uintptr][]js.Func)
	nextStreamJSFuncs uintptr
)

func retainJSFunc(fn js.Func) {
	jsFuncs = append(jsFuncs, fn)
}

func retainStreamJSFuncs(funcs ...js.Func) func() {
	streamJSFuncsMu.Lock()
	nextStreamJSFuncs++
	id := nextStreamJSFuncs
	streamJSFuncs[id] = funcs
	streamJSFuncsMu.Unlock()

	var releaseOnce sync.Once
	return func() {
		releaseOnce.Do(func() {
			streamJSFuncsMu.Lock()
			funcs, ok := streamJSFuncs[id]
			if ok {
				delete(streamJSFuncs, id)
			}
			streamJSFuncsMu.Unlock()

			if !ok {
				return
			}

			for _, fn := range funcs {
				fn.Release()
			}
		})
	}
}

func registerJSFunc(name string, fn func(this js.Value, args []js.Value) any) {
	jsFn := js.FuncOf(fn)
	retainJSFunc(jsFn)
	js.Global().Set(name, jsFn)
}

func registerWasmAPI() {
	// Export the browser-facing JS ABI:
	//   - lndWasmStart(extraArgs, successCb, errorCb)
	//   - lndWasmGetStatus()
	//   - lndWasmInvokeRPC(method, requestBytes, successCb, errorCb)
	//   - lndWasmOpenServerStream(method, requestBytes, successCb, errorCb)
	//   - lndWasmOpenBidiStream(method, successCb, errorCb)
	//   - lndWasmGossipSync(serviceUrl, cacheDir, dataDir, successCb, errorCb)
	//   - lndWasmCancelGossipSync()
	registerStartAPI()
	registerUnaryAPI()
	registerServerStreamAPI()
	registerBidiStreamAPI()
	registerSpeedloaderAPI()
}

func Main() {
	registerWasmAPI()
	select {}
}
