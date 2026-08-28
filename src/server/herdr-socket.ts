/**
 * NDJSON client for the herdr socket API.
 *
 * Wire format (verified against herdr 0.8.2, protocol 20):
 *   - Unix domain socket at ~/.config/herdr/herdr.sock (override: HERDR_SOCKET_PATH)
 *   - Request:  one JSON object + "\n"
 *   - Response: one JSON object + "\n"
 *   - Subscriptions keep the connection open and push further JSON lines.
 */
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

export interface RpcOk<T = any> { id: string; result: T }
export interface RpcErr { id: string; error: { code: string; message: string } }
export type RpcResponse<T = any> = RpcOk<T> | RpcErr;

export function isErr(r: RpcResponse): r is RpcErr {
  return "error" in r;
}

let seq = 0;
const nextId = () => `web-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Splits a byte stream into complete NDJSON lines. */
class LineSplitter {
  private buf = "";
  push(chunk: Buffer | string, onLine: (line: string) => void) {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) onLine(line);
    }
  }
}

/** One-shot request/response. Opens a connection, sends, reads one line, closes. */
export function rpc<T = any>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<RpcResponse<T>> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath());
    const splitter = new LineSplitter();
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };

    const timer = setTimeout(
      () => done(() => reject(new Error(`herdr rpc timeout: ${method}`))),
      timeoutMs,
    );

    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: nextId(), method, params }) + "\n");
    });
    sock.on("data", (chunk) =>
      splitter.push(chunk, (line) => {
        try {
          const parsed = JSON.parse(line);
          done(() => resolve(parsed));
        } catch (err) {
          done(() => reject(err));
        }
      }),
    );
    sock.on("error", (err) => done(() => reject(err)));
    sock.on("close", () =>
      done(() => reject(new Error(`herdr socket closed before responding: ${method}`))),
    );
  });
}

/** Throwing variant — returns the result payload directly. */
export async function call<T = any>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await rpc<T>(method, params);
  if (isErr(res)) throw new Error(`${method}: ${res.error.code}: ${res.error.message}`);
  return res.result;
}

/**
 * Long-lived event subscription. The socket stays open; each pushed event is
 * delivered to onEvent. Returns a close function.
 *
 * Valid subscription types come from the schema's Subscription enum; see
 * docs/API-NOTES.md for the full list.
 */
export function subscribe(
  subscriptions: Array<Record<string, unknown>>,
  onEvent: (evt: { event: string; data: any }) => void,
  onClose?: (reason: string) => void,
): () => void {
  const sock: Socket = connect(socketPath());
  const splitter = new LineSplitter();
  let acked = false;

  sock.on("connect", () => {
    sock.write(
      JSON.stringify({ id: nextId(), method: "events.subscribe", params: { subscriptions } }) + "\n",
    );
  });

  sock.on("data", (chunk) =>
    splitter.push(chunk, (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!acked) {
        acked = true;
        // First line is the ack: {result:{type:"subscription_started"}} or an error.
        if (msg.error) {
          onClose?.(`subscribe rejected: ${msg.error.message}`);
          sock.destroy();
        }
        return;
      }
      if (msg.event) onEvent(msg);
    }),
  );

  sock.on("error", (err) => onClose?.(`socket error: ${err.message}`));
  sock.on("close", () => onClose?.("socket closed"));

  return () => sock.destroy();
}
