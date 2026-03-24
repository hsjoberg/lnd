//go:build windows || plan9 || solaris || appengine || js
// +build windows plan9 solaris appengine js

package flags

func getTerminalColumns() int {
	return 80
}
