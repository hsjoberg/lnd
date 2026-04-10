import type { RefObject } from "react";
import type { FsBackend, RuntimeMode } from "../../runtime";

type RunAction = (
  label: string,
  action: () => Promise<unknown> | unknown,
) => Promise<unknown>;

type RuntimePanelProps = {
  fsBackend: FsBackend;
  runtimeMode: RuntimeMode;
  extraArgs: string;
  lndConf: string;
  runtimeStatus: string;
  onSetFsBackend: (value: FsBackend) => void;
  onSetRuntimeMode: (value: RuntimeMode) => void;
  onSetExtraArgs: (value: string) => void;
  onSetLndConf: (value: string) => void;
  onRunAction: RunAction;
  onLoadRuntime: () => Promise<unknown>;
  onStartLnd: () => Promise<unknown>;
  onAutoStartWallet: () => Promise<unknown>;
  onWriteLndConfig: () => Promise<unknown>;
  onGetStatus: () => { lnd_started: number };
  onGetState: () => Promise<unknown>;
  onGetInfo: () => Promise<unknown>;
  onGetNetworkInfo: () => Promise<unknown>;
  onGetNeutrinoStatus: () => Promise<unknown>;
  onBenchmarkGetInfo: (iterations: number) => Promise<unknown>;
  onBenchmarkGetNetworkInfo: (iterations: number) => Promise<unknown>;
  onBenchmarkListChannels: (iterations: number) => Promise<unknown>;
  onStopDaemon: () => Promise<unknown>;
  onListChannels: () => Promise<unknown>;
};

export function RuntimePanel(props: RuntimePanelProps) {
  return (
    <section className="panel runtime-panel">
      <h2>Runtime</h2>

      <div className="runtime-columns">
        <div className="runtime-section">
          <label htmlFor="fsBackend">FS backend</label>
          <select
            id="fsBackend"
            value={props.fsBackend}
            onChange={(event) => props.onSetFsBackend(event.target.value as FsBackend)}
          >
            <option value="opfs">opfs</option>
            <option value="memory">memory</option>
          </select>

          <label htmlFor="runtimeMode">Runtime mode</label>
          <select
            id="runtimeMode"
            value={props.runtimeMode}
            onChange={(event) =>
              props.onSetRuntimeMode(event.target.value as RuntimeMode)
            }
          >
            <option value="worker">Web Worker</option>
            <option value="direct">Main thread</option>
          </select>

          <div className="button-grid">
            <button
              disabled={props.runtimeStatus !== "not loaded"}
              onClick={() => void props.onRunAction("load wasm", props.onLoadRuntime)}
            >
              Load wasm
            </button>
            <button onClick={() => void props.onRunAction("start", props.onStartLnd)}>
              Start
            </button>
            <button
              onClick={() =>
                void props.onRunAction("auto_start_wallet", async () => {
                  await props.onAutoStartWallet();
                  return { ok: true };
                })
              }
            >
              Start + auto wallet
            </button>
            <button
              onClick={() =>
                void props.onRunAction("write_lnd_conf", props.onWriteLndConfig)
              }
            >
              Write lnd.conf
            </button>
            <button
              onClick={() =>
                void props.onRunAction("status", async () => props.onGetStatus())
              }
            >
              Get status
            </button>
            <button
              onClick={() =>
                void props.onRunAction("get_state", props.onGetState)
              }
            >
              Get state
            </button>
            <button onClick={() => void props.onRunAction("get_info", props.onGetInfo)}>
              Get info
            </button>
            <button
              onClick={() =>
                void props.onRunAction("get_network_info", props.onGetNetworkInfo)
              }
            >
              GetNetworkInfo
            </button>
            <button
              onClick={() =>
                void props.onRunAction("neutrino_status", props.onGetNeutrinoStatus)
              }
            >
              Neutrino Status
            </button>
            <button onClick={() => void props.onBenchmarkGetInfo(100)}>
              GetInfo x 100
            </button>
            <button onClick={() => void props.onBenchmarkGetNetworkInfo(10)}>
              GetNetworkInfo x 10
            </button>
            <button onClick={() => void props.onBenchmarkListChannels(100)}>
              ListChannels x 100
            </button>
            <button
              onClick={() => void props.onRunAction("stop_daemon", props.onStopDaemon)}
            >
              StopDaemon
            </button>
            <button
              className="alt"
              onClick={() => void props.onRunAction("list_channels", props.onListChannels)}
            >
              ListChannels
            </button>
          </div>
        </div>

        <div className="runtime-section">
          <label htmlFor="extraArgs">Start extraArgs</label>
          <textarea
            id="extraArgs"
            value={props.extraArgs}
            onChange={(event) => props.onSetExtraArgs(event.target.value)}
          />

          <label htmlFor="lndConf">/lnd/lnd.conf (OPFS)</label>
          <textarea
            id="lndConf"
            value={props.lndConf}
            onChange={(event) => props.onSetLndConf(event.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

export function ResultPanel({ lastResult }: { lastResult: string }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Last Result</h2>
        <span className="panel-note">
          BigInts and bytes are normalized for display.
        </span>
      </div>
      <pre className="scrollbox result-scrollbox">{lastResult}</pre>
    </section>
  );
}

type LogPanelProps = {
  logLines: string[];
  logScrollboxRef: RefObject<HTMLPreElement | null>;
  onScroll: () => void;
};

export function LogPanel(props: LogPanelProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Log</h2>
        <span className="panel-note">{props.logLines.length} lines kept</span>
      </div>
      <pre
        ref={props.logScrollboxRef}
        className="scrollbox log-scrollbox"
        onScroll={props.onScroll}
      >
        {props.logLines.join("\n")}
      </pre>
    </section>
  );
}

type WalletPanelProps = {
  seedPassphrase: string;
  walletPassword: string;
  seedWords: string;
  onSetSeedPassphrase: (value: string) => void;
  onSetWalletPassword: (value: string) => void;
  onSetSeedWords: (value: string) => void;
  onRunAction: RunAction;
  onGenSeed: () => Promise<unknown>;
  onInitWallet: () => Promise<unknown>;
  onUnlockWallet: () => Promise<unknown>;
};

export function WalletPanel(props: WalletPanelProps) {
  return (
    <section className="panel">
      <h2>Wallet</h2>

      <label htmlFor="seedPassphrase">Seed passphrase</label>
      <input
        id="seedPassphrase"
        value={props.seedPassphrase}
        onChange={(event) => props.onSetSeedPassphrase(event.target.value)}
        placeholder="Optional aezeed passphrase"
      />

      <label htmlFor="walletPassword">Wallet password</label>
      <input
        id="walletPassword"
        type="password"
        value={props.walletPassword}
        onChange={(event) => props.onSetWalletPassword(event.target.value)}
        placeholder="At least 8 chars"
      />

      <label htmlFor="seedWords">Mnemonic words</label>
      <textarea
        id="seedWords"
        value={props.seedWords}
        onChange={(event) => props.onSetSeedWords(event.target.value)}
        placeholder="Generated 24 words will appear here"
      />

      <div className="button-grid">
        <button onClick={() => void props.onRunAction("gen_seed", props.onGenSeed)}>
          GenSeed
        </button>
        <button onClick={() => void props.onRunAction("init_wallet", props.onInitWallet)}>
          InitWallet
        </button>
        <button
          onClick={() => void props.onRunAction("unlock_wallet", props.onUnlockWallet)}
        >
          UnlockWallet
        </button>
      </div>
    </section>
  );
}

type SpeedloaderPanelProps = {
  serviceUrl: string;
  cacheDir: string;
  dataDir: string;
  onSetServiceUrl: (value: string) => void;
  onSetCacheDir: (value: string) => void;
  onSetDataDir: (value: string) => void;
  onRunAction: RunAction;
  onRunSpeedloader: () => Promise<unknown>;
  onCancelSpeedloader: () => Promise<unknown>;
};

export function SpeedloaderPanel(props: SpeedloaderPanelProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Speedloader</h2>
        <span className="panel-note">runs mobile GossipSync before startup</span>
      </div>

      <label htmlFor="speedloaderServiceUrl">Service URL</label>
      <input
        id="speedloaderServiceUrl"
        value={props.serviceUrl}
        onChange={(event) => props.onSetServiceUrl(event.target.value)}
        placeholder="https://primer.blixtwallet.com"
      />

      <label htmlFor="speedloaderCacheDir">Cache dir</label>
      <input
        id="speedloaderCacheDir"
        value={props.cacheDir}
        onChange={(event) => props.onSetCacheDir(event.target.value)}
      />

      <label htmlFor="speedloaderDataDir">Data dir</label>
      <input
        id="speedloaderDataDir"
        value={props.dataDir}
        onChange={(event) => props.onSetDataDir(event.target.value)}
      />
      <div className="button-grid">
        <button onClick={() => void props.onRunAction("speedloader", props.onRunSpeedloader)}>
          GossipSync
        </button>
        <button
          className="alt"
          onClick={() =>
            void props.onRunAction("cancel_speedloader", props.onCancelSpeedloader)
          }
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

type StreamsPanelProps = {
  stateStreamActive: boolean;
  channelAcceptorActive: boolean;
  autoAcceptChannels: boolean;
  lastStateSubscriptionEvent: string;
  lastChannelAcceptRequest: string;
  onSetAutoAcceptChannels: (value: boolean) => void;
  onRunAction: RunAction;
  onStartSubscribeState: () => Promise<unknown>;
  onStartChannelAcceptor: () => Promise<unknown>;
  onStopChannelAcceptor: () => Promise<unknown>;
};

export function StreamsPanel(props: StreamsPanelProps) {
  return (
    <section className="panel">
      <h2>Streams</h2>

      <div className="panel-heading">
        <span className="panel-note">
          SubscribeState: {props.stateStreamActive ? "active" : "stopped"}
        </span>
      </div>
      <div className="button-grid">
        <button
          onClick={() =>
            void props.onRunAction("subscribe_state_start", props.onStartSubscribeState)
          }
        >
          Start SubscribeState
        </button>
      </div>
      <pre className="scrollbox">{props.lastStateSubscriptionEvent}</pre>

      <label htmlFor="autoAcceptChannels">
        <input
          id="autoAcceptChannels"
          type="checkbox"
          checked={props.autoAcceptChannels}
          onChange={(event) => props.onSetAutoAcceptChannels(event.target.checked)}
        />{" "}
        Auto-accept inbound channels
      </label>

      <div className="panel-heading">
        <span className="panel-note">
          ChannelAcceptor: {props.channelAcceptorActive ? "active" : "stopped"}
        </span>
      </div>
      <div className="button-grid">
        <button
          onClick={() =>
            void props.onRunAction(
              "channel_acceptor_start",
              props.onStartChannelAcceptor,
            )
          }
        >
          Start ChannelAcceptor
        </button>
        <button
          onClick={() =>
            void props.onRunAction(
              "channel_acceptor_stop",
              props.onStopChannelAcceptor,
            )
          }
        >
          Stop ChannelAcceptor
        </button>
      </div>
      <pre className="scrollbox">{props.lastChannelAcceptRequest}</pre>
    </section>
  );
}

type PaymentsPanelProps = {
  invoiceMemo: string;
  invoiceAmountSat: string;
  paymentRequest: string;
  onSetInvoiceMemo: (value: string) => void;
  onSetInvoiceAmountSat: (value: string) => void;
  onSetPaymentRequest: (value: string) => void;
  onRunAction: RunAction;
  onAddInvoice: () => Promise<unknown>;
  onDecodePayReq: () => Promise<unknown>;
  onSendPaymentSync: () => Promise<unknown>;
  onLookupInvoice: () => Promise<unknown>;
};

export function PaymentsPanel(props: PaymentsPanelProps) {
  return (
    <section className="panel">
      <h2>Payments</h2>

      <label htmlFor="invoiceMemo">Invoice memo</label>
      <input
        id="invoiceMemo"
        value={props.invoiceMemo}
        onChange={(event) => props.onSetInvoiceMemo(event.target.value)}
        placeholder="Invoice memo"
      />

      <label htmlFor="invoiceAmountSat">Invoice amount (sat)</label>
      <input
        id="invoiceAmountSat"
        value={props.invoiceAmountSat}
        onChange={(event) => props.onSetInvoiceAmountSat(event.target.value)}
        placeholder="1000"
      />

      <label htmlFor="paymentRequest">Payment request</label>
      <textarea
        id="paymentRequest"
        value={props.paymentRequest}
        onChange={(event) => props.onSetPaymentRequest(event.target.value)}
        placeholder="lnbcrt..."
      />

      <div className="button-grid">
        <button onClick={() => void props.onRunAction("add_invoice", props.onAddInvoice)}>
          AddInvoice
        </button>
        <button
          onClick={() => void props.onRunAction("decode_pay_req", props.onDecodePayReq)}
        >
          DecodePayReq
        </button>
        <button
          onClick={() =>
            void props.onRunAction("send_payment_sync", props.onSendPaymentSync)
          }
        >
          SendPaymentSync
        </button>
        <button
          onClick={() =>
            void props.onRunAction("lookup_invoice", props.onLookupInvoice)
          }
        >
          LookupInvoice
        </button>
      </div>
    </section>
  );
}

type ChannelsPanelProps = {
  channelPeerPubkey: string;
  channelAmountSat: string;
  onSetChannelPeerPubkey: (value: string) => void;
  onSetChannelAmountSat: (value: string) => void;
  onRunAction: RunAction;
  onOpenChannelSync: () => Promise<unknown>;
  onListChannels: () => Promise<unknown>;
};

export function ChannelsPanel(props: ChannelsPanelProps) {
  return (
    <section className="panel">
      <h2>Channels</h2>

      <label htmlFor="channelPeerPubkey">Channel peer pubkey</label>
      <input
        id="channelPeerPubkey"
        value={props.channelPeerPubkey}
        onChange={(event) => props.onSetChannelPeerPubkey(event.target.value)}
        placeholder="02..."
      />

      <label htmlFor="channelAmountSat">Channel amount (sat)</label>
      <input
        id="channelAmountSat"
        value={props.channelAmountSat}
        onChange={(event) => props.onSetChannelAmountSat(event.target.value)}
        placeholder="20000"
      />

      <div className="button-grid">
        <button
          onClick={() =>
            void props.onRunAction("open_channel_sync", props.onOpenChannelSync)
          }
        >
          OpenChannelSync
        </button>
        <button
          onClick={() => void props.onRunAction("list_channels", props.onListChannels)}
        >
          ListChannels
        </button>
      </div>
    </section>
  );
}

type PeersPanelProps = {
  connectPeerTarget: string;
  onSetConnectPeerTarget: (value: string) => void;
  onRunAction: RunAction;
  onConnectPeer: () => Promise<unknown>;
  onListPeers: () => Promise<unknown>;
};

export function PeersPanel(props: PeersPanelProps) {
  return (
    <section className="panel">
      <h2>Peers</h2>

      <label htmlFor="connectPeerTarget">Connect peer target</label>
      <input
        id="connectPeerTarget"
        value={props.connectPeerTarget}
        onChange={(event) => props.onSetConnectPeerTarget(event.target.value)}
        placeholder="pubkey@127.0.0.1:9735"
      />

      <div className="button-grid">
        <button
          onClick={() => void props.onRunAction("connect_peer", props.onConnectPeer)}
        >
          ConnectPeer
        </button>
        <button onClick={() => void props.onRunAction("list_peers", props.onListPeers)}>
          ListPeers
        </button>
      </div>
    </section>
  );
}
