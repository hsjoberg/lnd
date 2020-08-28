// Copyright (c) 2013-2017 The btcsuite developers
// Copyright (c) 2015-2016 The Decred developers
// Heavily inspired by https://github.com/btcsuite/btcd/blob/master/signal.go
// Copyright (C) 2015-2017 The Lightning Network Developers

package signal

import (
	"errors"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
)

type Channels struct {
	// interruptChannel is used to receive SIGINT (Ctrl+C) signals.
	interruptChannel chan os.Signal

	// shutdownRequestChannel is used to request the daemon to shutdown
	// gracefully, similar to when receiving SIGINT.
	shutdownRequestChannel chan struct{}

	// started indicates whether we have started our main interrupt handler.
	// This field should be used atomically.
	started int32

	// quit is closed when instructing the main interrupt handler to exit.
	quit chan struct{}

	// shutdownChannel is closed once the main interrupt handler exits.
	shutdownChannel chan struct{}
}

var channels Channels

// Intercept starts the interception of interrupt signals. Note that this
// function can only be called once.
func Intercept() error {
	if !atomic.CompareAndSwapInt32(&channels.started, 0, 1) {
		return errors.New("intercept already started")
	}

	channels.interruptChannel = make(chan os.Signal, 1)
	channels.shutdownRequestChannel = make(chan struct{})
	channels.quit = make(chan struct{})
	channels.shutdownChannel = make(chan struct{})

	signalsToCatch := []os.Signal{
		os.Interrupt,
		os.Kill,
		syscall.SIGABRT,
		syscall.SIGTERM,
		syscall.SIGQUIT,
	}
	signal.Notify(channels.interruptChannel, signalsToCatch...)
	go mainInterruptHandler()

	return nil
}

// mainInterruptHandler listens for SIGINT (Ctrl+C) signals on the
// interruptChannel and shutdown requests on the shutdownRequestChannel, and
// invokes the registered interruptCallbacks accordingly. It also listens for
// callback registration.
// It must be run as a goroutine.
func mainInterruptHandler() {
	// isShutdown is a flag which is used to indicate whether or not
	// the shutdown signal has already been received and hence any future
	// attempts to add a new interrupt handler should invoke them
	// immediately.
	var isShutdown bool

	// shutdown invokes the registered interrupt handlers, then signals the
	// shutdownChannel.
	shutdown := func() {
		// Ignore more than one shutdown signal.
		if isShutdown {
			log.Infof("Already shutting down...")
			return
		}
		isShutdown = true
		log.Infof("Shutting down...")

		// Signal the main interrupt handler to exit, and stop accept
		// post-facto requests.
		close(channels.quit)
	}

	for {
		select {
		case signal := <-channels.interruptChannel:
			log.Infof("Received %v", signal)
			shutdown()

		case <-channels.shutdownRequestChannel:
			log.Infof("Received shutdown request.")
			shutdown()

		case <-channels.quit:
			log.Infof("Gracefully shutting down.")
			close(channels.shutdownChannel)
			atomic.StoreInt32(&channels.started, 0)
			return
		}
	}
}

// Listening returns true if the main interrupt handler has been started, and
// has not been killed.
func Listening() bool {
	// If our started field is not set, we are not yet listening for
	// interrupts.
	if atomic.LoadInt32(&channels.started) != 1 {
		return false
	}

	// If we have started our main goroutine, we check whether we have
	// stopped it yet.
	return Alive()
}

// Alive returns true if the main interrupt handler has not been killed.
func Alive() bool {
	select {
	case <-channels.quit:
		return false
	default:
		return true
	}
}

// RequestShutdown initiates a graceful shutdown from the application.
func RequestShutdown() {
	select {
	case channels.shutdownRequestChannel <- struct{}{}:
	case <-channels.quit:
	}
}

// ShutdownChannel returns the channel that will be closed once the main
// interrupt handler has exited.
func ShutdownChannel() <-chan struct{} {
	return channels.shutdownChannel
}
