package lnd

// The transport abstraction lives in the tor package: Config.net is typed as
// tor.Net even when the active implementation is not Tor-specific.
import "github.com/lightningnetwork/lnd/tor"

// SetEmbeddedNet overrides the runtime networking implementation used by an
// embedded config.
//
// Config.net is intentionally kept internal to lnd. Embedded targets such as
// wasm still need a way to swap the transport after LoadConfig has built the
// rest of the config, so we expose only this narrow setter instead of making
// the field public.
func SetEmbeddedNet(cfg *Config, network tor.Net) {
	if cfg != nil {
		cfg.net = network
	}
}
