//go:build js && wasm
// +build js,wasm

package lncfg

func useExternalWalletDBForLocalBackend() bool {
	return true
}
