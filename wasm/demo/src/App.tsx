import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { useEffect, useRef, useState } from "react";
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
  WalletState,
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
  attachStdoutListener,
  getWasmStatus,
  invokeRpc,
  loadWasmRuntime,
  openBidiStream,
  openServerStream,
  startWasm,
  type FsBackend,
  type RuntimeMode,
} from "../../runtime";

type ResultValue = string | Record<string, unknown>;

const DEFAULT_EXTRA_ARGS =
  '--lnddir="/lnd" --bitcoin.node=neutrino --bitcoin.testnet --norest --no-rest-tls --nolisten --nobootstrap --no-macaroons --tlsdisableautofill --rpclisten=127.0.0.1:10009 --restlisten=127.0.0.1:8080 --tor.socks=127.0.0.1:9050 --tor.control=127.0.0.1:9051 --debuglevel="info"';

const encoder = new TextEncoder();

function encodeBytes(value: string) {
  return encoder.encode(value);
}

function parseSeedWords(seedWords: string) {
  return seedWords
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function bytesToBase64(bytes: Uint8Array) {
  let raw = "";
  for (const byte of bytes) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw);
}

function hexToBytes(value: string) {
  const hex = value.trim().replace(/^0x/, "");
  if (!hex) {
    return new Uint8Array();
  }
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("invalid hex string");
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function toDisplayValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      bytes_base64: bytesToBase64(value),
      length: value.length,
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toDisplayValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "$typeName")
    .map(([key, entryValue]) => [key, toDisplayValue(entryValue)]);

  return Object.fromEntries(entries);
}

function stringifyResult(value: ResultValue) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(toDisplayValue(value), null, 2);
}

function formatDurationMs(durationMs: number) {
  return `${durationMs.toFixed(1)} ms`;
}

function stateName(state: WalletState) {
  return WalletState[state] ?? String(state);
}

function parseConnectPeerTarget(value: string) {
  const target = value.trim();
  const atIndex = target.indexOf("@");
  if (atIndex <= 0 || atIndex === target.length - 1) {
    throw new Error("connect peer target must be in pubkey@host:port format");
  }

  const pubkey = target.slice(0, atIndex).trim();
  const host = target.slice(atIndex + 1).trim();
  if (!pubkey || !host) {
    throw new Error("connect peer target must be in pubkey@host:port format");
  }

  return { pubkey, host };
}

function appendMissingFlags(args: string, flags: string[]) {
  let nextArgs = args.trim();

  for (const flag of flags) {
    if (!nextArgs.includes(flag)) {
      nextArgs = nextArgs ? `${nextArgs} ${flag}` : flag;
    }
  }

  return nextArgs;
}

async function invokeUnary<TResponse>(
  method: string,
  requestSchema: any,
  requestInit: Record<string, unknown>,
  responseSchema: any,
) {
  const request = create(requestSchema, requestInit);
  const requestBytes = toBinary(requestSchema, request);
  const responseBytes = await invokeRpc(method, requestBytes);
  return fromBinary(responseSchema, responseBytes) as TResponse;
}

function App() {
  const [fsBackend, setFsBackend] = useState<FsBackend>("opfs");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("worker");
  const [extraArgs, setExtraArgs] = useState(DEFAULT_EXTRA_ARGS);
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

  function appendLog(message: string) {
    setLogLines((current) => {
      return [...current, message].slice(-500);
    });
  }

  useEffect(() => {
    return attachStdoutListener(
      (line) => {
        setLogLines((current) => [...current, line].slice(-500));
      },
      runtimeMode,
    );
  }, [runtimeMode]);

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
    action: () => Promise<ResultValue> | ResultValue,
  ) {
    const startedAt = performance.now();
    try {
      const result = await action();
      showTimedResult(label, startedAt, result);
      return result;
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
      await startWasm(appendMissingFlags(extraArgs, ["--noseedbackup"]));
    } else {
      appendLog("lnd already started");
    }
  }

  async function benchmarkGetInfo(iterations = 100) {
    const startedAt = performance.now();
    let lastInfo: GetInfoResponse | null = null;

    for (let index = 0; index < iterations; index++) {
      lastInfo = await getInfo();
    }

    const elapsedMs = performance.now() - startedAt;
    showResult(`get_info x ${iterations}`, {
      elapsed_ms: Number(elapsedMs.toFixed(1)),
      elapsed: formatDurationMs(elapsedMs),
      iterations,
      avg_ms: Number((elapsedMs / iterations).toFixed(2)),
      last_result: lastInfo ?? {},
    });
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <h1>lnd wasm</h1>
        <span className="runtime-pill">{runtimeStatus}</span>
      </section>

      <div className="app-grid">
        <div className="top-row">
          <section className="panel">
            <h2>Runtime</h2>
            <label htmlFor="fsBackend">FS backend</label>
            <select
              id="fsBackend"
              value={fsBackend}
              onChange={(event) =>
                setFsBackend(event.target.value as FsBackend)
              }
            >
              <option value="opfs">opfs</option>
              <option value="memory">memory</option>
            </select>

            <label htmlFor="runtimeMode">Runtime mode</label>
            <select
              id="runtimeMode"
              value={runtimeMode}
              onChange={(event) =>
                setRuntimeMode(event.target.value as RuntimeMode)
              }
            >
              <option value="worker">Web Worker</option>
              <option value="direct">Main thread</option>
            </select>

            <label htmlFor="extraArgs">Start extraArgs</label>
            <textarea
              id="extraArgs"
              value={extraArgs}
              onChange={(event) => setExtraArgs(event.target.value)}
            />

            <div className="button-grid">
              <button onClick={() => void runAction("load wasm", loadRuntime)}>
                Load wasm
              </button>
              <button
                className="alt"
                onClick={() =>
                  void runAction("start", async () => {
                    await startWasm(extraArgs);
                    setRuntimeStatus(`started (${runtimeMode})`);
                    return { ok: true };
                  })
                }
              >
                Start
              </button>
              <button
                onClick={() =>
                  void runAction("auto_start_wallet", async () => {
                    await autoStartAndWallet();
                    return { ok: true };
                  })
                }
              >
                Start + auto wallet
              </button>
              <button
                className="alt"
                onClick={() =>
                  void runAction("status", async () => ({
                    lnd_started: getWasmStatus(),
                  }))
                }
              >
                Get status
              </button>
              <button
                onClick={() =>
                  void runAction("get_state", async () => {
                    const response = await getState();
                    return {
                      ...response,
                      state_name: stateName(response.state),
                    };
                  })
                }
              >
                Get state
              </button>
              <button
                className="alt"
                onClick={() => void runAction("get_info", getInfo)}
              >
                Get info
              </button>
              <button
                className="alt"
                onClick={() =>
                  void runAction("get_network_info", getNetworkInfo)
                }
              >
                GetNetworkInfo
              </button>
              <button
                className="alt"
                onClick={() =>
                  void runAction("neutrino_status", getNeutrinoStatus)
                }
              >
                Neutrino Status
              </button>
              <button onClick={() => void benchmarkGetInfo(100)}>
                GetInfo x 100
              </button>
              <button
                className="alt"
                onClick={() => void runAction("stop_daemon", stopDaemon)}
              >
                StopDaemon
              </button>
              <button
                className="alt"
                onClick={() => void runAction("list_channels", listChannels)}
              >
                ListChannels
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>Last Result</h2>
              <span className="panel-note">
                BigInts and bytes are normalized for display.
              </span>
            </div>
            <pre className="scrollbox result-scrollbox">{lastResult}</pre>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>Log</h2>
              <span className="panel-note">{logLines.length} lines kept</span>
            </div>
            <pre className="scrollbox log-scrollbox">{logLines.join("\n")}</pre>
          </section>
        </div>

        <section className="panel">
          <h2>Wallet</h2>

          <label htmlFor="seedPassphrase">Seed passphrase</label>
          <input
            id="seedPassphrase"
            value={seedPassphrase}
            onChange={(event) => setSeedPassphrase(event.target.value)}
            placeholder="Optional aezeed passphrase"
          />

          <label htmlFor="walletPassword">Wallet password</label>
          <input
            id="walletPassword"
            type="password"
            value={walletPassword}
            onChange={(event) => setWalletPassword(event.target.value)}
            placeholder="At least 8 chars"
          />

          <label htmlFor="seedWords">Mnemonic words</label>
          <textarea
            id="seedWords"
            value={seedWords}
            onChange={(event) => setSeedWords(event.target.value)}
            placeholder="Generated 24 words will appear here"
          />

          <div className="button-grid">
            <button
              onClick={() =>
                void runAction("gen_seed", async () => {
                  const response = await genSeed();
                  setSeedWords(response.cipherSeedMnemonic.join(" "));
                  return response;
                })
              }
            >
              GenSeed
            </button>
            <button
              className="alt"
              onClick={() => void runAction("init_wallet", initWallet)}
            >
              InitWallet
            </button>
            <button
              onClick={() => void runAction("unlock_wallet", unlockWallet)}
            >
              UnlockWallet
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Streams</h2>

          <div className="panel-heading">
            <span className="panel-note">
              SubscribeState: {stateStreamActive ? "active" : "stopped"}
            </span>
          </div>
          <div className="button-grid">
            <button
              onClick={() =>
                void runAction("subscribe_state_start", startSubscribeState)
              }
            >
              Start SubscribeState
            </button>
          </div>
          <pre className="scrollbox">{lastStateSubscriptionEvent}</pre>

          <label htmlFor="autoAcceptChannels">
            <input
              id="autoAcceptChannels"
              type="checkbox"
              checked={autoAcceptChannels}
              onChange={(event) => setAutoAcceptChannels(event.target.checked)}
            />{" "}
            Auto-accept inbound channels
          </label>

          <div className="panel-heading">
            <span className="panel-note">
              ChannelAcceptor: {channelAcceptorActive ? "active" : "stopped"}
            </span>
          </div>
          <div className="button-grid">
            <button
              onClick={() =>
                void runAction("channel_acceptor_start", startChannelAcceptor)
              }
            >
              Start ChannelAcceptor
            </button>
            <button
              className="alt"
              onClick={() =>
                void runAction("channel_acceptor_stop", stopChannelAcceptor)
              }
            >
              Stop ChannelAcceptor
            </button>
          </div>
          <pre className="scrollbox">{lastChannelAcceptRequest}</pre>
        </section>

        <section className="panel">
          <h2>Payments</h2>

          <label htmlFor="invoiceMemo">Invoice memo</label>
          <input
            id="invoiceMemo"
            value={invoiceMemo}
            onChange={(event) => setInvoiceMemo(event.target.value)}
            placeholder="Invoice memo"
          />

          <label htmlFor="invoiceAmountSat">Invoice amount (sat)</label>
          <input
            id="invoiceAmountSat"
            value={invoiceAmountSat}
            onChange={(event) => setInvoiceAmountSat(event.target.value)}
            placeholder="1000"
          />

          <label htmlFor="paymentRequest">Payment request</label>
          <textarea
            id="paymentRequest"
            value={paymentRequest}
            onChange={(event) => setPaymentRequest(event.target.value)}
            placeholder="lnbcrt..."
          />

          <div className="button-grid">
            <button onClick={() => void runAction("add_invoice", addInvoice)}>
              AddInvoice
            </button>
            <button
              className="alt"
              onClick={() => void runAction("decode_pay_req", decodePayReq)}
            >
              DecodePayReq
            </button>
            <button
              onClick={() =>
                void runAction("send_payment_sync", sendPaymentSync)
              }
            >
              SendPaymentSync
            </button>
            <button
              className="alt"
              onClick={() => void runAction("lookup_invoice", lookupInvoice)}
            >
              LookupInvoice
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Channels</h2>

          <label htmlFor="channelPeerPubkey">Channel peer pubkey</label>
          <input
            id="channelPeerPubkey"
            value={channelPeerPubkey}
            onChange={(event) => setChannelPeerPubkey(event.target.value)}
            placeholder="02..."
          />

          <label htmlFor="channelAmountSat">Channel amount (sat)</label>
          <input
            id="channelAmountSat"
            value={channelAmountSat}
            onChange={(event) => setChannelAmountSat(event.target.value)}
            placeholder="20000"
          />

          <div className="button-grid">
            <button
              onClick={() =>
                void runAction("open_channel_sync", openChannelSync)
              }
            >
              OpenChannelSync
            </button>
            <button
              className="alt"
              onClick={() => void runAction("list_channels", listChannels)}
            >
              ListChannels
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Peers</h2>

          <label htmlFor="connectPeerTarget">Connect peer target</label>
          <input
            id="connectPeerTarget"
            value={connectPeerTarget}
            onChange={(event) => setConnectPeerTarget(event.target.value)}
            placeholder="pubkey@127.0.0.1:9735"
          />

          <div className="button-grid">
            <button onClick={() => void runAction("connect_peer", connectPeer)}>
              ConnectPeer
            </button>
            <button
              className="alt"
              onClick={() => void runAction("list_peers", listPeers)}
            >
              ListPeers
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
