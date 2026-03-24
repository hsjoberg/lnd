package lnd

import (
	"errors"
	"os"
	"runtime"
	"strings"
)

func isWasmNotImplemented(err error) bool {
	if err == nil || runtime.GOOS != "js" {
		return false
	}

	if errors.Is(err, os.ErrNotExist) {
		return false
	}

	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not implemented on js") ||
		strings.Contains(msg, "not implemented")
}

func mkdirAllCompat(path string, perm os.FileMode) error {
	err := os.MkdirAll(path, perm)
	if isWasmNotImplemented(err) {
		return nil
	}

	return err
}
