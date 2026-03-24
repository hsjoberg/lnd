//go:build !(js && wasm)

package chainfee

import (
	"net"
	"net/http"
)

// GetFeeInfo will query the web API, parse the response and return a map of
// confirmation targets to sat/kw fees and min relay feerate in a parsed
// response.
func (s SparseConfFeeSource) GetFeeInfo() (WebAPIResponse, error) {
	// Rather than use the default http.Client, we'll make a custom one
	// which will allow us to control how long we'll wait to read the
	// response from the service. This way, if the service is down or
	// overloaded, we can exit early and use our default fee.
	netTransport := &http.Transport{
		Dial: (&net.Dialer{
			Timeout: WebAPIConnectionTimeout,
		}).Dial,
		TLSHandshakeTimeout: WebAPIConnectionTimeout,
	}
	netClient := &http.Client{
		Timeout:   WebAPIResponseTimeout,
		Transport: netTransport,
	}

	// With the client created, we'll query the API source to fetch the URL
	// that we should use to query for the fee estimation.
	targetURL := s.URL
	resp, err := netClient.Get(targetURL)
	if err != nil {
		log.Errorf("unable to query web api for fee response: %v",
			err)
		return WebAPIResponse{}, err
	}
	defer resp.Body.Close()

	// Once we've obtained the response, we'll instruct the WebAPIFeeSource
	// to parse out the body to obtain our final result.
	parsedResp, err := s.parseResponse(resp.Body)
	if err != nil {
		log.Errorf("unable to parse fee api response: %v", err)

		return WebAPIResponse{}, err
	}

	return parsedResp, nil
}
