//go:build js && wasm

package main

import "github.com/lightningnetwork/lnd/wasm/backend"

func main() {
	backend.Main()
}
