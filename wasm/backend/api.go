//go:build js && wasm

package backend

import "syscall/js"

var (
	jsFuncs []js.Func
)

func retainJSFunc(fn js.Func) {
	jsFuncs = append(jsFuncs, fn)
}

func registerJSFunc(name string, fn func(this js.Value, args []js.Value) any) {
	jsFn := js.FuncOf(fn)
	retainJSFunc(jsFn)
	js.Global().Set(name, jsFn)
}

func registerWasmAPI() {
	registerStartAPI()
	registerUnaryAPI()
	registerServerStreamAPI()
	registerBidiStreamAPI()
}

func Main() {
	registerWasmAPI()
	select {}
}
