//go:build js && wasm

package backend

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/lightningnetwork/lnd/lnwire"
	"github.com/lightningnetwork/lnd/tor"
)

// Browser networking shim used by the wasm backend. It plugs into lnd's
// existing tor.Net abstraction and routes Lightning and Neutrino peer traffic
// over browser WebSockets instead of raw TCP.

type timeoutError struct{}

const (
	websocketPortOffset         = 2000
	websocketReadPoolSize       = 64 * 1024
	websocketWriteQueueSize     = 64
	websocketWriteBatchMaxBytes = 256 * 1024
)

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

type pooledWebsocketBuffer struct {
	buf []byte
}

type websocketReadChunk struct {
	data   []byte
	offset int
	pooled *pooledWebsocketBuffer
}

type websocketWriteRequest struct {
	data []byte
}

var (
	expiredDeadlineCh = func() chan time.Time {
		ch := make(chan time.Time)
		close(ch)
		return ch
	}()
	websocketReadBufferPool = sync.Pool{
		New: func() any {
			return &pooledWebsocketBuffer{
				buf: make([]byte, websocketReadPoolSize),
			}
		},
	}
)

type websocketConn struct {
	url        string
	alias      string
	remoteAddr net.Addr
	ws         js.Value
	onOpen     js.Func
	onOpenSet  bool
	onMessage  js.Func
	onMsgSet   bool
	onError    js.Func
	onErrSet   bool
	onClose    js.Func
	onCloseSet bool
	readQueue  chan websocketReadChunk
	closeCh    chan struct{}
	closeOnce  sync.Once
	closeErrMu sync.RWMutex
	closeErr   error
	readBufMu  sync.Mutex
	readBuf    []websocketReadChunk
	writeQueue chan websocketWriteRequest
	deadlineMu sync.RWMutex
	readDL     time.Time
	writeDL    time.Time
}

func websocketStateString(state int) string {
	switch state {
	case 0:
		return "CONNECTING"
	case 1:
		return "OPEN"
	case 2:
		return "CLOSING"
	case 3:
		return "CLOSED"
	default:
		return strconv.Itoa(state)
	}
}

func websocketErrorDetails(ws js.Value, event js.Value) string {
	parts := []string{
		fmt.Sprintf("readyState=%s", websocketStateString(ws.Get("readyState").Int())),
	}

	if protocol := ws.Get("protocol"); protocol.Type() == js.TypeString && protocol.String() != "" {
		parts = append(parts, fmt.Sprintf("protocol=%q", protocol.String()))
	}

	if event.Truthy() {
		if typ := event.Get("type"); typ.Type() == js.TypeString && typ.String() != "" {
			parts = append(parts, fmt.Sprintf("event=%q", typ.String()))
		}
		if message := event.Get("message"); message.Type() == js.TypeString && message.String() != "" {
			parts = append(parts, fmt.Sprintf("message=%q", message.String()))
		}
	}

	return strings.Join(parts, ", ")
}

func websocketCloseError(ws js.Value, event js.Value) error {
	parts := []string{
		fmt.Sprintf("readyState=%s", websocketStateString(ws.Get("readyState").Int())),
	}

	if protocol := ws.Get("protocol"); protocol.Type() == js.TypeString && protocol.String() != "" {
		parts = append(parts, fmt.Sprintf("protocol=%q", protocol.String()))
	}

	if event.Truthy() {
		if code := event.Get("code"); code.Type() == js.TypeNumber {
			parts = append(parts, fmt.Sprintf("code=%d", code.Int()))
		}
		if reason := event.Get("reason"); reason.Type() == js.TypeString && reason.String() != "" {
			parts = append(parts, fmt.Sprintf("reason=%q", reason.String()))
		}
		if wasClean := event.Get("wasClean"); wasClean.Type() == js.TypeBoolean {
			parts = append(parts, fmt.Sprintf("clean=%t", wasClean.Bool()))
		}
	}

	return fmt.Errorf("websocket closed: %s", strings.Join(parts, ", "))
}

func newWebsocketConn(url, alias string, remoteAddr net.Addr,
	timeout time.Duration) (*websocketConn, error) {

	wsCtor := js.Global().Get("WebSocket")
	if wsCtor.IsUndefined() {
		return nil, errors.New("WebSocket API not available")
	}

	conn := &websocketConn{
		url:        url,
		alias:      alias,
		remoteAddr: remoteAddr,
		readQueue:  make(chan websocketReadChunk, 32),
		writeQueue: make(chan websocketWriteRequest, websocketWriteQueueSize),
		closeCh:    make(chan struct{}),
	}

	openCh := make(chan struct{})
	errCh := make(chan error, 1)

	ws := wsCtor.New(url)
	ws.Set("binaryType", "arraybuffer")
	conn.ws = ws

	conn.onOpen = js.FuncOf(func(js.Value, []js.Value) any {
		select {
		case <-openCh:
		default:
			close(openCh)
		}
		return nil
	})
	conn.onOpenSet = true
	conn.onClose = js.FuncOf(func(_ js.Value, args []js.Value) any {
		err := io.EOF
		if len(args) > 0 {
			err = websocketCloseError(conn.ws, args[0])
		}
		conn.setCloseErr(err)
		conn.close()
		return nil
	})
	conn.onCloseSet = true
	conn.onError = js.FuncOf(func(_ js.Value, args []js.Value) any {
		err := fmt.Errorf("websocket error: %s", websocketErrorDetails(conn.ws, js.Undefined()))
		if len(args) > 0 {
			err = fmt.Errorf("websocket error: %s", websocketErrorDetails(conn.ws, args[0]))
		}
		select {
		case errCh <- err:
		default:
		}
		conn.setCloseErr(err)
		conn.close()
		return nil
	})
	conn.onErrSet = true
	conn.onMessage = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 {
			return nil
		}

		data := args[0].Get("data")
		uint8Array := js.Global().Get("Uint8Array").New(data)
		payload, pooled := acquireWebsocketReadBuffer(
			uint8Array.Get("length").Int(),
		)
		js.CopyBytesToGo(payload, uint8Array)
		chunk := websocketReadChunk{
			data:   payload,
			pooled: pooled,
		}

		select {
		case conn.readQueue <- chunk:
		case <-conn.closeCh:
			releaseWebsocketReadChunk(chunk)
		}
		return nil
	})
	conn.onMsgSet = true

	ws.Set("onopen", conn.onOpen)
	ws.Set("onerror", conn.onError)
	ws.Set("onclose", conn.onClose)
	ws.Set("onmessage", conn.onMessage)
	go conn.writeLoop()

	if timeout == 0 {
		select {
		case <-openCh:
			return conn, nil
		case err := <-errCh:
			return nil, err
		}
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-openCh:
		return conn, nil
	case err := <-errCh:
		return nil, err
	case <-timer.C:
		conn.setCloseErr(timeoutError{})
		conn.close()
		return nil, timeoutError{}
	}
}

func (c *websocketConn) Read(p []byte) (int, error) {
	for {
		c.readBufMu.Lock()
		if len(c.readBuf) > 0 {
			n := c.readQueuedLocked(p)
			c.readBufMu.Unlock()
			return n, nil
		}
		c.readBufMu.Unlock()

		// Drain any already-queued websocket frames before honoring closeCh so
		// a final payload delivered just before socket close is not dropped.
		select {
		case payload := <-c.readQueue:
			c.readBufMu.Lock()
			c.readBuf = append(c.readBuf, payload)
			c.readBufMu.Unlock()
			continue
		default:
		}

		readDeadline, stopDeadline := c.readDeadlineWait()
		select {
		case payload := <-c.readQueue:
			c.readBufMu.Lock()
			c.readBuf = append(c.readBuf, payload)
			c.readBufMu.Unlock()
		case <-c.closeCh:
			stopDeadline()
			select {
			case payload := <-c.readQueue:
				c.readBufMu.Lock()
				c.readBuf = append(c.readBuf, payload)
				c.readBufMu.Unlock()
				continue
			default:
			}
			return 0, c.getCloseErr()
		case <-readDeadline:
			stopDeadline()
			return 0, timeoutError{}
		}
		stopDeadline()
	}
}

func (c *websocketConn) Write(p []byte) (n int, err error) {
	select {
	case <-c.closeCh:
		return 0, c.getCloseErr()
	case <-c.writeDeadlineWaitChan():
		return 0, timeoutError{}
	default:
	}

	owned := append([]byte(nil), p...)
	request := websocketWriteRequest{data: owned}

	select {
	case c.writeQueue <- request:
		return len(p), nil
	case <-c.closeCh:
		return 0, c.getCloseErr()
	case <-c.writeDeadlineWaitChan():
		return 0, timeoutError{}
	}
}

func (c *websocketConn) Close() error {
	c.close()
	return nil
}

func (c *websocketConn) LocalAddr() net.Addr {
	return &net.TCPAddr{
		IP:   net.IPv4(127, 0, 0, 1),
		Port: 0,
	}
}

func (c *websocketConn) RemoteAddr() net.Addr {
	if c.remoteAddr != nil {
		return c.remoteAddr
	}

	return &net.TCPAddr{
		IP:   net.IPv4(127, 0, 0, 1),
		Port: 0,
	}
}

func (c *websocketConn) SetDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()

	c.readDL = t
	c.writeDL = t
	return nil
}

func (c *websocketConn) SetReadDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()

	c.readDL = t
	return nil
}

func (c *websocketConn) SetWriteDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()

	c.writeDL = t
	return nil
}

func (c *websocketConn) readDeadlineWait() (<-chan time.Time, func()) {
	c.deadlineMu.RLock()
	defer c.deadlineMu.RUnlock()

	return deadlineWait(c.readDL)
}

func (c *websocketConn) writeDeadlineWaitChan() <-chan time.Time {
	c.deadlineMu.RLock()
	defer c.deadlineMu.RUnlock()

	ch, _ := deadlineWait(c.writeDL)
	return ch
}

func (c *websocketConn) setCloseErr(err error) {
	c.closeErrMu.Lock()
	defer c.closeErrMu.Unlock()

	if c.closeErr == nil {
		c.closeErr = err
	}
}

func (c *websocketConn) getCloseErr() error {
	c.closeErrMu.RLock()
	defer c.closeErrMu.RUnlock()

	if c.closeErr != nil {
		return c.closeErr
	}

	return io.EOF
}

func (c *websocketConn) readQueuedLocked(p []byte) int {
	if len(p) == 0 {
		return 0
	}

	total := 0
	for len(c.readBuf) > 0 && total < len(p) {
		chunk := &c.readBuf[0]
		n := copy(p[total:], chunk.data[chunk.offset:])
		total += n
		chunk.offset += n
		if chunk.offset < len(chunk.data) {
			break
		}

		releaseWebsocketReadChunk(*chunk)
		c.readBuf[0] = websocketReadChunk{}
		c.readBuf = c.readBuf[1:]
	}

	return total
}

func (c *websocketConn) writeLoop() {
	batch := make([]byte, 0, websocketWriteBatchMaxBytes)
	var pending *websocketWriteRequest

	for {
		var request websocketWriteRequest
		if pending != nil {
			request = *pending
			pending = nil
		} else {
			select {
			case <-c.closeCh:
				return
			case request = <-c.writeQueue:
			}
		}

		if len(request.data) == 0 {
			continue
		}

		batch = append(batch[:0], request.data...)
		drain := true
		for drain && len(batch) < websocketWriteBatchMaxBytes {
			select {
			case next := <-c.writeQueue:
				if len(next.data) == 0 {
					continue
				}

				if len(batch)+len(next.data) > websocketWriteBatchMaxBytes {
					pending = &next
					drain = false
					continue
				}

				batch = append(batch, next.data...)
			default:
				drain = false
			}
		}

		if err := c.sendBatch(batch); err != nil {
			c.setCloseErr(err)
			c.close()
			return
		}
	}
}

func (c *websocketConn) sendBatch(batch []byte) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("websocket send failed: %v", r)
		}
	}()

	data := js.Global().Get("Uint8Array").New(len(batch))
	js.CopyBytesToJS(data, batch)
	c.ws.Call("send", data)
	return nil
}

func acquireWebsocketReadBuffer(size int) ([]byte, *pooledWebsocketBuffer) {
	if size <= 0 {
		return nil, nil
	}

	if size <= websocketReadPoolSize {
		pooled := websocketReadBufferPool.Get().(*pooledWebsocketBuffer)
		return pooled.buf[:size], pooled
	}

	return make([]byte, size), nil
}

func releaseWebsocketReadChunk(chunk websocketReadChunk) {
	if chunk.pooled == nil {
		return
	}

	chunk.pooled.buf = chunk.pooled.buf[:websocketReadPoolSize]
	websocketReadBufferPool.Put(chunk.pooled)
}

func deadlineWait(deadline time.Time) (<-chan time.Time, func()) {
	if deadline.IsZero() {
		return nil, func() {}
	}

	delay := time.Until(deadline)
	if delay <= 0 {
		return expiredDeadlineCh, func() {}
	}

	timer := time.NewTimer(delay)
	return timer.C, func() {
		if timer.Stop() {
			return
		}

		select {
		case <-timer.C:
		default:
		}
	}
}

func (c *websocketConn) close() {
	c.closeOnce.Do(func() {
		if c.ws.Truthy() {
			c.ws.Set("onopen", js.Null())
			c.ws.Set("onmessage", js.Null())
			c.ws.Set("onerror", js.Null())
			c.ws.Set("onclose", js.Null())
			c.ws.Call("close")
		}
		if c.onOpenSet {
			c.onOpen.Release()
			c.onOpenSet = false
		}
		if c.onMsgSet {
			c.onMessage.Release()
			c.onMsgSet = false
		}
		if c.onErrSet {
			c.onError.Release()
			c.onErrSet = false
		}
		if c.onCloseSet {
			c.onClose.Release()
			c.onCloseSet = false
		}
		close(c.closeCh)
	})
}

type websocketNet struct {
	mu                sync.RWMutex
	hostBySyntheticIP map[string]string
	syntheticIPByHost map[string]string
	nextSyntheticIP   uint32
}

var _ tor.Net = (*websocketNet)(nil)

func newWebsocketNet() *websocketNet {
	return &websocketNet{
		hostBySyntheticIP: make(map[string]string),
		syntheticIPByHost: make(map[string]string),
	}
}

func websocketScheme() string {
	location := js.Global().Get("location")
	if location.Truthy() && location.Get("protocol").String() == "https:" {
		return "wss://"
	}

	return "ws://"
}

func (n *websocketNet) Dial(network, address string, timeout time.Duration) (net.Conn, error) {
	switch network {
	case "tcp", "tcp4", "tcp6":
	default:
		return nil, fmt.Errorf("unsupported network %q", network)
	}

	wsURL, err := n.route(address)
	if err != nil {
		return nil, err
	}

	remoteAddr, err := n.connRemoteAddr(address)
	if err != nil {
		return nil, err
	}

	return newWebsocketConn(wsURL, address, remoteAddr, timeout)
}

func (n *websocketNet) LookupHost(host string) ([]string, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []string{host}, nil
	}

	n.mu.Lock()
	defer n.mu.Unlock()

	if ip, ok := n.syntheticIPByHost[host]; ok {
		return []string{ip}, nil
	}

	// Hostname targets are routed to browser WebSocket endpoints, so we only
	// need a stable synthetic IP here to satisfy callers that insist on a
	// resolved TCP address before dialing. The actual socket destination is
	// derived later in route() from the original hostname.
	index := n.nextSyntheticIP
	n.nextSyntheticIP++
	syntheticIP := fmt.Sprintf(
		"198.18.%d.%d", (index/254)%256, (index%254)+1,
	)

	n.syntheticIPByHost[host] = syntheticIP
	n.hostBySyntheticIP[syntheticIP] = host

	return []string{syntheticIP}, nil
}

func (n *websocketNet) LookupSRV(service, proto, name string, timeout time.Duration) (string, []*net.SRV, error) {
	return "", nil, fmt.Errorf("srv lookup disabled in wasm for %s.%s.%s", service, proto, name)
}

func (n *websocketNet) ResolveTCPAddr(network, address string) (*net.TCPAddr, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}

	addrs, err := n.LookupHost(host)
	if err != nil {
		return nil, err
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("no addresses found for %s", host)
	}

	portNum, err := strconv.Atoi(port)
	if err != nil {
		return nil, err
	}

	return &net.TCPAddr{
		IP:   net.ParseIP(addrs[0]),
		Port: portNum,
	}, nil
}

func (n *websocketNet) connRemoteAddr(address string) (net.Addr, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}

	portNum, err := strconv.Atoi(port)
	if err != nil {
		return nil, err
	}

	if ip := net.ParseIP(host); ip != nil {
		return &net.TCPAddr{
			IP:   ip,
			Port: portNum,
		}, nil
	}

	n.mu.RLock()
	originalHost, isSynthetic := n.hostBySyntheticIP[host]
	n.mu.RUnlock()
	if isSynthetic {
		host = originalHost
	}

	if ip := net.ParseIP(host); ip != nil {
		return &net.TCPAddr{
			IP:   ip,
			Port: portNum,
		}, nil
	}

	return &lnwire.DNSAddress{
		Hostname: host,
		Port:     uint16(portNum),
	}, nil
}

func (n *websocketNet) route(address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", fmt.Errorf("invalid websocket peer address %q: %w", address, err)
	}

	if host == "" {
		return "", errors.New("websocket peer host is empty")
	}

	n.mu.RLock()
	originalHost, isSynthetic := n.hostBySyntheticIP[host]
	n.mu.RUnlock()
	if isSynthetic {
		host = originalHost
	}

	// If this is IPv6, preserve bracket formatting in the URL host component.
	if parsed := net.ParseIP(host); parsed != nil && parsed.To4() == nil {
		host = "[" + host + "]"
	}

	portNum, err := strconv.Atoi(port)
	if err != nil {
		return "", fmt.Errorf("invalid websocket peer port %q: %w", port, err)
	}

	wsPort := portNum + websocketPortOffset
	if wsPort > 65535 {
		return "", fmt.Errorf(
			"websocket peer port overflow for %q: %d + %d exceeds 65535",
			address, portNum, websocketPortOffset,
		)
	}

	return websocketScheme() + host + ":" + strconv.Itoa(wsPort), nil
}
