//go:build js && wasm

package backend

import (
	"errors"
	"fmt"
	"sync/atomic"
	"syscall/js"

	"google.golang.org/protobuf/encoding/protojson"
	protov2 "google.golang.org/protobuf/proto"
)

type jsCallback struct {
	onResponse js.Value
	onError    js.Value
}

type jsRecvStream struct {
	onResponse js.Value
	onError    js.Value
	stopped    uint32
}

func validateJSCallbacks(responseName string, response js.Value, errorName string, errorCb js.Value) error {
	if response.Type() != js.TypeFunction {
		return fmt.Errorf("%s must be a JavaScript function", responseName)
	}

	if errorCb.Type() != js.TypeFunction {
		return fmt.Errorf("%s must be a JavaScript function", errorName)
	}

	return nil
}

func (c *jsCallback) OnResponse(data []byte) {
	c.onResponse.Invoke(bytesToJS(data))
}

func (c *jsCallback) OnError(err error) {
	c.onError.Invoke(err.Error())
}

func (s *jsRecvStream) OnResponse(data []byte) {
	if atomic.LoadUint32(&s.stopped) != 0 {
		return
	}
	s.onResponse.Invoke(bytesToJS(data))
}

func (s *jsRecvStream) OnError(err error) {
	if atomic.LoadUint32(&s.stopped) != 0 {
		return
	}
	s.onError.Invoke(err.Error())
}

func (s *jsRecvStream) Stop() {
	atomic.StoreUint32(&s.stopped, 1)
}

type jsProtoJSONCallback struct {
	newResponse func() protov2.Message
	onResponse  js.Value
	onError     js.Value
}

func (c *jsProtoJSONCallback) OnResponse(data []byte) {
	resp := c.newResponse()
	if err := protov2.Unmarshal(data, resp); err != nil {
		c.OnError(err)
		return
	}

	jsonBytes, err := protojson.MarshalOptions{
		UseProtoNames:   true,
		EmitUnpopulated: true,
	}.Marshal(resp)
	if err != nil {
		c.OnError(err)
		return
	}

	c.onResponse.Invoke(string(jsonBytes))
}

func (c *jsProtoJSONCallback) OnError(err error) {
	c.onError.Invoke(err.Error())
}

type statusCallback struct {
	value int32
}

func (c *statusCallback) OnResponse(started int32) {
	c.value = started
}

func bytesToJS(data []byte) js.Value {
	array := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(array, data)
	return array
}

func bytesFromJS(v js.Value) ([]byte, error) {
	if v.IsUndefined() || v.IsNull() {
		return nil, nil
	}

	length := v.Get("length")
	if length.IsUndefined() || length.Type() != js.TypeNumber {
		return nil, errors.New("expected Uint8Array-compatible value")
	}

	data := make([]byte, length.Int())
	js.CopyBytesToGo(data, v)
	return data, nil
}

func newJSStreamHandle(send func([]byte) error, stop func() error) js.Value {
	obj := js.Global().Get("Object").New()

	var sendFn js.Func
	if send != nil {
		sendFn = js.FuncOf(func(_ js.Value, args []js.Value) any {
			if len(args) != 1 {
				return "stream send expects one Uint8Array argument"
			}

			msg, err := bytesFromJS(args[0])
			if err != nil {
				return err.Error()
			}
			if err := send(msg); err != nil {
				return err.Error()
			}
			return nil
		})
		retainJSFunc(sendFn)
		obj.Set("send", sendFn)
	}

	stopFn := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		if err := stop(); err != nil {
			return err.Error()
		}
		return nil
	})
	retainJSFunc(stopFn)
	obj.Set("stop", stopFn)

	return obj
}
