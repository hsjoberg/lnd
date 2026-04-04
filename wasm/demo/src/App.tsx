// (globalThis as any).__lndWasmMirrorStdoutToConsole = true;
// (globalThis as any).__lndWasmDisableOPFSSyncAccess = true;
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AddInvoiceResponseSchema,
  ChannelAcceptRequestSchema,
  ChannelAcceptResponseSchema,
  ChannelPointSchema,
  ConnectPeerRequestSchema,
  ConnectPeerResponseSchema,
  GetInfoRequestSchema,
  GetInfoResponseSchema,
  InvoiceSchema,
  LightningAddressSchema,
  ListPeersRequestSchema,
  ListPeersResponseSchema,
  ListChannelsRequestSchema,
  ListChannelsResponseSchema,
  NetworkInfoRequestSchema,
  NetworkInfoSchema,
  OpenChannelRequestSchema,
  PayReqSchema,
  PayReqStringSchema,
  PaymentHashSchema,
  SendRequestSchema,
  SendResponseSchema,
  StopRequestSchema,
  StopResponseSchema,
} from "react-native-turbo-lnd/protos/lightning_pb";
import type {
  AddInvoiceResponse,
  ChannelAcceptRequest,
  ChannelPoint,
  ConnectPeerResponse,
  GenSeedResponse,
  GetInfoResponse,
  InitWalletResponse,
  Invoice,
  ListChannelsResponse,
  ListPeersResponse,
  NetworkInfo,
  OpenChannelRequest,
  PayReq,
  SendResponse,
  StopResponse,
} from "react-native-turbo-lnd/protos/lightning_pb";
import {
  StatusRequestSchema as NeutrinoStatusRequestSchema,
  StatusResponseSchema as NeutrinoStatusResponseSchema,
} from "react-native-turbo-lnd/protos/neutrinorpc/neutrino_pb";
import type { StatusResponse as NeutrinoStatusResponse } from "react-native-turbo-lnd/protos/neutrinorpc/neutrino_pb";
import {
  GetStateRequestSchema,
  GetStateResponseSchema,
  SubscribeStateRequestSchema,
  SubscribeStateResponseSchema,
} from "react-native-turbo-lnd/protos/stateservice_pb";
import type {
  GetStateResponse,
  SubscribeStateResponse,
} from "react-native-turbo-lnd/protos/stateservice_pb";
import {
  GenSeedRequestSchema,
  GenSeedResponseSchema,
  InitWalletRequestSchema,
  InitWalletResponseSchema,
  UnlockWalletRequestSchema,
  UnlockWalletResponseSchema,
} from "react-native-turbo-lnd/protos/walletunlocker_pb";
import type { UnlockWalletResponse } from "react-native-turbo-lnd/protos/walletunlocker_pb";
import "./App.css";
import {
  ChannelsPanel,
  LoadspeederPanel,
  LogPanel,
  PaymentsPanel,
  PeersPanel,
  ResultPanel,
  RuntimePanel,
  StreamsPanel,
  WalletPanel,
} from "./demo-panels";
import {
  appendMissingFlags,
  bytesToBase64,
  DEFAULT_EXTRA_ARGS,
  DEFAULT_LND_CONF,
  DEFAULT_LOADSPEEDER_TARGET_PATH,
  DEFAULT_LOADSPEEDER_URL,
  downloadFileToOPFS,
  encodeBytes,
  formatDurationMs,
  hexToBytes,
  invokeUnary,
  parseConnectPeerTarget,
  parseSeedWords,
  stateName,
  stringifyResult,
  textByteLength,
  writeTextFileToOPFS,
} from "./demo-support";
import type { ResultValue } from "./demo-support";
import {
  attachStdoutListener,
  hasLoadedWasmRuntime,
  getWasmStatus,
  loadWasmRuntime,
  openBidiStream,
  openServerStream,
  startWasm,
  type FsBackend,
  type RuntimeMode,
} from "../../runtime";

function App() {
  const [fsBackend, setFsBackend] = useState<FsBackend>("opfs");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("worker");
  const [extraArgs, setExtraArgs] = useState(DEFAULT_EXTRA_ARGS);
  const [lndConf, setLndConf] = useState(DEFAULT_LND_CONF);
  const [loadspeederUrl, setLoadspeederUrl] = useState(DEFAULT_LOADSPEEDER_URL);
  const [seedPassphrase, setSeedPassphrase] = useState("");
  const [walletPassword, setWalletPassword] = useState("password123");
  const [seedWords, setSeedWords] = useState("");
  const [invoiceMemo, setInvoiceMemo] = useState("wasm test");
  const [invoiceAmountSat, setInvoiceAmountSat] = useState("1000");
  const [paymentRequest, setPaymentRequest] = useState("");
  const [latestInvoiceHash, setLatestInvoiceHash] = useState<Uint8Array | null>(
    null,
  );
  const [connectPeerTarget, setConnectPeerTarget] = useState("");
  const [channelPeerPubkey, setChannelPeerPubkey] = useState("");
  const [channelAmountSat, setChannelAmountSat] = useState("20000");
  const [stateStreamActive, setStateStreamActive] = useState(false);
  const [channelAcceptorActive, setChannelAcceptorActive] = useState(false);
  const [autoAcceptChannels, setAutoAcceptChannels] = useState(true);
  const [lastStateSubscriptionEvent, setLastStateSubscriptionEvent] =
    useState("{}");
  const [lastChannelAcceptRequest, setLastChannelAcceptRequest] =
    useState("{}");
  const [runtimeStatus, setRuntimeStatus] = useState("not loaded");
  const [lastResult, setLastResult] = useState("{}");
  const [logLines, setLogLines] = useState<string[]>([]);
  const subscribeStateActiveRef = useRef(false);
  const channelAcceptorHandleRef = useRef<ReturnType<
    typeof openBidiStream
  > | null>(null);
  const logBufferRef = useRef<string[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);
  const logScrollboxRef = useRef<HTMLPreElement | null>(null);
  const shouldAutoScrollLogsRef = useRef(true);

  function updateLogAutoScrollState() {
    const element = logScrollboxRef.current;
    if (!element) {
      return;
    }

    const bottomGap =
      element.scrollHeight - element.clientHeight - element.scrollTop;
    shouldAutoScrollLogsRef.current = bottomGap <= 24;
  }

  function flushQueuedLogs() {
    if (logFlushTimerRef.current != null) {
      window.clearTimeout(logFlushTimerRef.current);
      logFlushTimerRef.current = null;
    }

    if (logBufferRef.current.length === 0) {
      return;
    }

    const pending = logBufferRef.current;
    logBufferRef.current = [];
    setLogLines((current) => [...current, ...pending].slice(-500));
  }

  function queueLogLine(message: string) {
    logBufferRef.current.push(message);
    if (logFlushTimerRef.current == null) {
      logFlushTimerRef.current = window.setTimeout(flushQueuedLogs, 50);
    }
  }

  function appendLog(message: string) {
    queueLogLine(message);
  }

  useEffect(() => {
    return attachStdoutListener((line) => {
      queueLogLine(line);
    }, runtimeMode);
  }, [runtimeMode]);

  useEffect(() => {
    return () => {
      flushQueuedLogs();
      if (logFlushTimerRef.current != null) {
        window.clearTimeout(logFlushTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const element = logScrollboxRef.current;
    if (!element || !shouldAutoScrollLogsRef.current) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [logLines]);

  function showResult(label: string, value: ResultValue) {
    setLastResult(`${label}\n${stringifyResult(value)}`);
    appendLog(`${label} ok`);
  }

  function showError(label: string, error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    setLastResult(`${label} error\n${message}`);
    appendLog(`${label} error: ${message}`);
  }

  function showTimedResult(
    label: string,
    startedAt: number,
    value: ResultValue,
  ) {
    const elapsedMs = performance.now() - startedAt;
    showResult(label, {
      elapsed_ms: Number(elapsedMs.toFixed(1)),
      elapsed: formatDurationMs(elapsedMs),
      result: value,
    });
  }

  function showTimedError(label: string, startedAt: number, error: unknown) {
    const elapsedMs = performance.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    showError(label, {
      elapsed_ms: Number(elapsedMs.toFixed(1)),
      elapsed: formatDurationMs(elapsedMs),
      error: message,
    });
  }

  async function runAction(
    label: string,
    action: () => Promise<unknown> | unknown,
  ) {
    const startedAt = performance.now();
    try {
      const result = await action();
      showTimedResult(label, startedAt, result as ResultValue);
      return result as ResultValue;
    } catch (error) {
      showTimedError(label, startedAt, error);
      throw error;
    }
  }

  async function loadRuntime() {
    const status = await loadWasmRuntime(fsBackend, runtimeMode);
    setRuntimeStatus(`wasm loaded (${runtimeMode})`);
    appendLog(`fs backing: ${status.mode}`);
    appendLog(`wasm runtime loaded (${runtimeMode})`);
    return { ok: true };
  }

  async function writeLndConfig() {
    if (fsBackend !== "opfs") {
      throw new Error(
        "writing lnd.conf from the example currently requires OPFS",
      );
    }

    await writeTextFileToOPFS("/lnd/lnd.conf", lndConf);
    appendLog("wrote /lnd/lnd.conf");
    return {
      path: "/lnd/lnd.conf",
      bytes: textByteLength(lndConf),
      backend: fsBackend,
    };
  }

  async function startLnd() {
    if (fsBackend === "opfs") {
      await writeLndConfig();
    }

    await startWasm(extraArgs);
    setRuntimeStatus(`started (${runtimeMode})`);
    return { ok: true };
  }

  async function runLoadspeeder() {
    if (fsBackend !== "opfs") {
      throw new Error("loadspeeder currently requires the OPFS backend");
    }

    if (hasLoadedWasmRuntime() && getWasmStatus()) {
      throw new Error("loadspeeder requires lnd to be stopped");
    }

    const url = loadspeederUrl.trim();
    if (!url) {
      throw new Error("missing loadspeeder URL");
    }

    const targetPath = DEFAULT_LOADSPEEDER_TARGET_PATH;
    appendLog(`loadspeeder downloading ${url}`);
    const bytes = await downloadFileToOPFS(url, targetPath);
    appendLog(`loadspeeder wrote ${targetPath}`);
    return {
      url,
      target_path: targetPath,
      bytes,
    };
  }

  async function getState() {
    return invokeUnary<GetStateResponse>(
      "GetState",
      GetStateRequestSchema,
      {},
      GetStateResponseSchema,
    );
  }

  async function getInfo() {
    return invokeUnary<GetInfoResponse>(
      "GetInfo",
      GetInfoRequestSchema,
      {},
      GetInfoResponseSchema,
    );
  }

  async function genSeed() {
    return invokeUnary<GenSeedResponse>(
      "GenSeed",
      GenSeedRequestSchema,
      {
        aezeedPassphrase: encodeBytes(seedPassphrase),
      },
      GenSeedResponseSchema,
    );
  }

  async function initWallet() {
    return invokeUnary<InitWalletResponse>(
      "InitWallet",
      InitWalletRequestSchema,
      {
        walletPassword: encodeBytes(walletPassword),
        cipherSeedMnemonic: parseSeedWords(seedWords),
        aezeedPassphrase: encodeBytes(seedPassphrase),
        recoveryWindow: 0,
        statelessInit: false,
      },
      InitWalletResponseSchema,
    );
  }

  async function unlockWallet() {
    return invokeUnary<UnlockWalletResponse>(
      "UnlockWallet",
      UnlockWalletRequestSchema,
      {
        walletPassword: encodeBytes(walletPassword),
      },
      UnlockWalletResponseSchema,
    );
  }

  async function connectPeer() {
    const { pubkey, host } = parseConnectPeerTarget(connectPeerTarget);

    return invokeUnary<ConnectPeerResponse>(
      "ConnectPeer",
      ConnectPeerRequestSchema,
      {
        addr: create(LightningAddressSchema, {
          pubkey,
          host,
        }),
      },
      ConnectPeerResponseSchema,
    );
  }

  async function listPeers() {
    return invokeUnary<ListPeersResponse>(
      "ListPeers",
      ListPeersRequestSchema,
      {},
      ListPeersResponseSchema,
    );
  }

  async function getNetworkInfo() {
    return invokeUnary<NetworkInfo>(
      "GetNetworkInfo",
      NetworkInfoRequestSchema,
      {},
      NetworkInfoSchema,
    );
  }

  async function getNeutrinoStatus() {
    return invokeUnary<NeutrinoStatusResponse>(
      "NeutrinoKitStatus",
      NeutrinoStatusRequestSchema,
      {},
      NeutrinoStatusResponseSchema,
    );
  }

  async function stopDaemon() {
    const response = await invokeUnary<StopResponse>(
      "StopDaemon",
      StopRequestSchema,
      {},
      StopResponseSchema,
    );

    subscribeStateActiveRef.current = false;
    channelAcceptorHandleRef.current = null;
    setStateStreamActive(false);
    setChannelAcceptorActive(false);
    setRuntimeStatus("stopped");
    return response;
  }

  async function listChannels() {
    return invokeUnary<ListChannelsResponse>(
      "ListChannels",
      ListChannelsRequestSchema,
      {},
      ListChannelsResponseSchema,
    );
  }

  async function addInvoice() {
    const value = Number(invoiceAmountSat);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("invoice amount must be a positive number");
    }

    const response = await invokeUnary<AddInvoiceResponse>(
      "AddInvoice",
      InvoiceSchema,
      {
        memo: invoiceMemo,
        value,
      },
      AddInvoiceResponseSchema,
    );

    setLatestInvoiceHash(response.rHash);
    setPaymentRequest(response.paymentRequest);
    return response;
  }

  async function decodePayReq() {
    if (!paymentRequest.trim()) {
      throw new Error("missing payment request");
    }

    return invokeUnary<PayReq>(
      "DecodePayReq",
      PayReqStringSchema,
      {
        payReq: paymentRequest.trim(),
      },
      PayReqSchema,
    );
  }

  async function sendPaymentSync() {
    if (!paymentRequest.trim()) {
      throw new Error("missing payment request");
    }

    return invokeUnary<SendResponse>(
      "SendPaymentSync",
      SendRequestSchema,
      {
        paymentRequest: paymentRequest.trim(),
        feeLimitSat: 1000,
      },
      SendResponseSchema,
    );
  }

  async function lookupInvoice() {
    if (!latestInvoiceHash) {
      throw new Error("no invoice hash available yet");
    }

    return invokeUnary<Invoice>(
      "LookupInvoice",
      PaymentHashSchema,
      {
        rHash: latestInvoiceHash,
      },
      InvoiceSchema,
    );
  }

  async function openChannelSync() {
    const peerPubkey = channelPeerPubkey.trim();
    if (!peerPubkey) {
      throw new Error("missing channel peer pubkey");
    }

    const amount = Number(channelAmountSat);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("channel amount must be a positive number");
    }

    return invokeUnary<ChannelPoint>(
      "OpenChannelSync",
      OpenChannelRequestSchema,
      {
        nodePubkey: hexToBytes(peerPubkey),
        localFundingAmount: BigInt(amount),
        private: false,
      } satisfies Partial<OpenChannelRequest>,
      ChannelPointSchema,
    );
  }

  async function startSubscribeState() {
    if (subscribeStateActiveRef.current) {
      throw new Error("SubscribeState is already active");
    }

    const request = create(SubscribeStateRequestSchema, {});
    const requestBytes = toBinary(SubscribeStateRequestSchema, request);

    openServerStream(
      "SubscribeState",
      requestBytes,
      (responseBytes) => {
        const response = fromBinary(
          SubscribeStateResponseSchema,
          responseBytes,
        ) as SubscribeStateResponse;
        const display = {
          ...response,
          state_name: stateName(response.state),
        };
        setLastStateSubscriptionEvent(stringifyResult(display));
        appendLog(`subscribe_state: ${stateName(response.state)}`);
      },
      (error) => {
        subscribeStateActiveRef.current = false;
        setStateStreamActive(false);
        appendLog(`subscribe_state ended: ${error}`);
      },
    );

    subscribeStateActiveRef.current = true;
    setStateStreamActive(true);
    return { subscribed: true };
  }

  async function startChannelAcceptor() {
    if (channelAcceptorHandleRef.current) {
      throw new Error("ChannelAcceptor is already active");
    }

    let handle: ReturnType<typeof openBidiStream> | null = null;
    handle = openBidiStream(
      "ChannelAcceptor",
      (responseBytes) => {
        const request = fromBinary(
          ChannelAcceptRequestSchema,
          responseBytes,
        ) as ChannelAcceptRequest;

        setLastChannelAcceptRequest(
          stringifyResult(request as unknown as Record<string, unknown>),
        );
        appendLog(
          `channel_acceptor request: pending_chan_id=${bytesToBase64(request.pendingChanId)}`,
        );

        if (!autoAcceptChannels || !handle) {
          return;
        }

        const response = create(ChannelAcceptResponseSchema, {
          accept: true,
          pendingChanId: request.pendingChanId,
        });
        handle.send(toBinary(ChannelAcceptResponseSchema, response));
        appendLog("channel_acceptor accepted request");
      },
      (error) => {
        channelAcceptorHandleRef.current = null;
        setChannelAcceptorActive(false);
        appendLog(`channel_acceptor ended: ${error}`);
      },
    );

    channelAcceptorHandleRef.current = handle;
    setChannelAcceptorActive(true);
    return { accepting: true };
  }

  async function stopChannelAcceptor() {
    const handle = channelAcceptorHandleRef.current;
    if (!handle) {
      return { accepting: false };
    }

    handle.stop();
    channelAcceptorHandleRef.current = null;
    setChannelAcceptorActive(false);
    appendLog("channel_acceptor stopped");
    return { accepting: false };
  }

  async function autoStartAndWallet() {
    if (!getWasmStatus()) {
      appendLog("starting lnd");
      if (fsBackend === "opfs") {
        await writeLndConfig();
      }
      await startWasm(appendMissingFlags(extraArgs, ["--noseedbackup"]));
    } else {
      appendLog("lnd already started");
    }
  }

  async function benchmarkGetInfo(iterations = 100) {
    return benchmarkUnary("get_info", iterations, getInfo);
  }

  async function benchmarkGetNetworkInfo(iterations = 100) {
    return benchmarkUnary("get_network_info", iterations, getNetworkInfo);
  }

  async function benchmarkListChannels(iterations = 100) {
    return benchmarkUnary("list_channels", iterations, listChannels);
  }

  async function benchmarkUnary<TResponse>(
    label: string,
    iterations: number,
    action: () => Promise<TResponse>,
  ) {
    const startedAt = performance.now();
    let lastResult: TResponse | null = null;

    for (let index = 0; index < iterations; index++) {
      lastResult = await action();
    }

    const elapsedMs = performance.now() - startedAt;
    showResult(`${label} x ${iterations}`, {
      elapsed_ms: Number(elapsedMs.toFixed(1)),
      elapsed: formatDurationMs(elapsedMs),
      iterations,
      avg_ms: Number((elapsedMs / iterations).toFixed(2)),
      last_result: lastResult ?? {},
    });
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-row">
          <h1>lnd wasm</h1>
          <span className="runtime-pill">{runtimeStatus}</span>
        </div>
      </section>

      <div className="app-grid">
        <RuntimePanel
          fsBackend={fsBackend}
          runtimeMode={runtimeMode}
          extraArgs={extraArgs}
          lndConf={lndConf}
          runtimeStatus={runtimeStatus}
          onSetFsBackend={setFsBackend}
          onSetRuntimeMode={setRuntimeMode}
          onSetExtraArgs={setExtraArgs}
          onSetLndConf={setLndConf}
          onRunAction={runAction}
          onLoadRuntime={loadRuntime}
          onStartLnd={startLnd}
          onAutoStartWallet={autoStartAndWallet}
          onWriteLndConfig={writeLndConfig}
          onGetStatus={() => ({ lnd_started: getWasmStatus() })}
          onGetState={async () => {
            const response = await getState();
            return {
              ...response,
              state_name: stateName(response.state),
            };
          }}
          onGetInfo={getInfo}
          onGetNetworkInfo={getNetworkInfo}
          onGetNeutrinoStatus={getNeutrinoStatus}
          onBenchmarkGetInfo={benchmarkGetInfo}
          onBenchmarkGetNetworkInfo={benchmarkGetNetworkInfo}
          onBenchmarkListChannels={benchmarkListChannels}
          onStopDaemon={stopDaemon}
          onListChannels={listChannels}
        />

        <ResultPanel lastResult={lastResult} />
        <LogPanel
          logLines={logLines}
          logScrollboxRef={logScrollboxRef}
          onScroll={updateLogAutoScrollState}
        />
        <WalletPanel
          seedPassphrase={seedPassphrase}
          walletPassword={walletPassword}
          seedWords={seedWords}
          onSetSeedPassphrase={setSeedPassphrase}
          onSetWalletPassword={setWalletPassword}
          onSetSeedWords={setSeedWords}
          onRunAction={runAction}
          onGenSeed={async () => {
            const response = await genSeed();
            setSeedWords(response.cipherSeedMnemonic.join(" "));
            return response;
          }}
          onInitWallet={initWallet}
          onUnlockWallet={unlockWallet}
        />
        <LoadspeederPanel
          loadspeederUrl={loadspeederUrl}
          targetPath={DEFAULT_LOADSPEEDER_TARGET_PATH}
          onSetLoadspeederUrl={setLoadspeederUrl}
          onRunAction={runAction}
          onRunLoadspeeder={runLoadspeeder}
        />
        <StreamsPanel
          stateStreamActive={stateStreamActive}
          channelAcceptorActive={channelAcceptorActive}
          autoAcceptChannels={autoAcceptChannels}
          lastStateSubscriptionEvent={lastStateSubscriptionEvent}
          lastChannelAcceptRequest={lastChannelAcceptRequest}
          onSetAutoAcceptChannels={setAutoAcceptChannels}
          onRunAction={runAction}
          onStartSubscribeState={startSubscribeState}
          onStartChannelAcceptor={startChannelAcceptor}
          onStopChannelAcceptor={stopChannelAcceptor}
        />
        <PaymentsPanel
          invoiceMemo={invoiceMemo}
          invoiceAmountSat={invoiceAmountSat}
          paymentRequest={paymentRequest}
          onSetInvoiceMemo={setInvoiceMemo}
          onSetInvoiceAmountSat={setInvoiceAmountSat}
          onSetPaymentRequest={setPaymentRequest}
          onRunAction={runAction}
          onAddInvoice={addInvoice}
          onDecodePayReq={decodePayReq}
          onSendPaymentSync={sendPaymentSync}
          onLookupInvoice={lookupInvoice}
        />
        <ChannelsPanel
          channelPeerPubkey={channelPeerPubkey}
          channelAmountSat={channelAmountSat}
          onSetChannelPeerPubkey={setChannelPeerPubkey}
          onSetChannelAmountSat={setChannelAmountSat}
          onRunAction={runAction}
          onOpenChannelSync={openChannelSync}
          onListChannels={listChannels}
        />
        <PeersPanel
          connectPeerTarget={connectPeerTarget}
          onSetConnectPeerTarget={setConnectPeerTarget}
          onRunAction={runAction}
          onConnectPeer={connectPeer}
          onListPeers={listPeers}
        />
      </div>
    </main>
  );
}

export default App;
