package lnd

import (
	"net"

	"github.com/lightningnetwork/lnd/lncfg"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// The embedded admin transport stays in-process in wasm, so it does not need
// the normal TLS manager path or client TLS credentials.
func embeddedAdminTransportDialOption() grpc.DialOption {
	return grpc.WithTransportCredentials(insecure.NewCredentials())
}

func embeddedRestListener(a net.Addr) (net.Listener, error) {
	return lncfg.ListenOnAddress(a)
}
