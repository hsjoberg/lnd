//go:build !js
// +build !js

package lncfg

func useExternalWalletDBForLocalBackend() bool {
	return false
}
