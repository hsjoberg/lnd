import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { WalletState } from "react-native-turbo-lnd/protos/stateservice_pb";
import { invokeRpc } from "../../runtime";

export type ResultValue = string | Record<string, unknown>;

export const DEFAULT_EXTRA_ARGS =
  '--lnddir="/lnd" --bitcoin.node=neutrino --bitcoin.testnet --norest --no-rest-tls --nolisten --nobootstrap --no-macaroons --tlsdisableautofill --rpclisten=127.0.0.1:10009 --restlisten=127.0.0.1:8080 --tor.socks=127.0.0.1:9050 --tor.control=127.0.0.1:9051 --debuglevel="info"';

export const DEFAULT_LND_CONF = ``;

export const DEFAULT_SPEEDLOADER_SERVICE_URL =
  "https://primer.blixtwallet.com";

export const DEFAULT_SPEEDLOADER_CACHE_DIR = "/lnd/speedloader-cache";

export const DEFAULT_SPEEDLOADER_DATA_DIR = "/lnd";

const encoder = new TextEncoder();

export function encodeBytes(value: string) {
  return encoder.encode(value);
}

export function textByteLength(value: string) {
  return encoder.encode(value).length;
}

export async function createOPFSWritable(path: string) {
  if (
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== "function"
  ) {
    throw new Error("OPFS is not available in this browser/context");
  }

  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("path must point to a file");
  }

  let directory = await navigator.storage.getDirectory();
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await directory.getFileHandle(parts[parts.length - 1], {
    create: true,
  });
  return fileHandle.createWritable();
}

export async function writeTextFileToOPFS(path: string, contents: string) {
  const writable = await createOPFSWritable(path);
  await writable.write(contents);
  await writable.close();
}

export async function downloadFileToOPFS(url: string, path: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error("download response did not include a body");
  }

  const writable = await createOPFSWritable(path);
  const reader = response.body.getReader();
  let bytesWritten = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      bytesWritten += value.length;
      await writable.write(value);
    }
  } catch (error) {
    await writable.abort();
    throw error;
  }

  await writable.close();
  return bytesWritten;
}

export function parseSeedWords(seedWords: string) {
  return seedWords
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function bytesToBase64(bytes: Uint8Array) {
  let raw = "";
  for (const byte of bytes) {
    raw += String.fromCharCode(byte);
  }
  return btoa(raw);
}

export function hexToBytes(value: string) {
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

export function stringifyResult(value: ResultValue) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(toDisplayValue(value), null, 2);
}

export function formatDurationMs(durationMs: number) {
  return `${durationMs.toFixed(1)} ms`;
}

export function stateName(state: WalletState) {
  return WalletState[state] ?? String(state);
}

export function parseConnectPeerTarget(value: string) {
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

export function appendMissingFlags(args: string, flags: string[]) {
  let nextArgs = args.trim();

  for (const flag of flags) {
    if (!nextArgs.includes(flag)) {
      nextArgs = nextArgs ? `${nextArgs} ${flag}` : flag;
    }
  }

  return nextArgs;
}

export async function invokeUnary<TResponse>(
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
