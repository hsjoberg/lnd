//go:build js && wasm

package chainfee

import "net/http"

// GetFeeInfo will query the web API, parse the response and return a map of
// confirmation targets to sat/kw fees and min relay feerate in a parsed
// response.
func (s SparseConfFeeSource) GetFeeInfo() (WebAPIResponse, error) {
	// In the browser, custom dialers bypass the js/wasm HTTP transport and
	// fall back to unsupported raw DNS/TCP. Use the default client path so Go
	// routes requests through the browser HTTP stack instead.
	netClient := &http.Client{
		Timeout: WebAPIResponseTimeout,
	}

	targetURL := s.URL
	resp, err := netClient.Get(targetURL)
	if err != nil {
		log.Errorf("unable to query web api for fee response: %v",
			err)
		return WebAPIResponse{}, err
	}
	defer resp.Body.Close()

	parsedResp, err := s.parseResponse(resp.Body)
	if err != nil {
		log.Errorf("unable to parse fee api response: %v", err)

		return WebAPIResponse{}, err
	}

	return parsedResp, nil
}
