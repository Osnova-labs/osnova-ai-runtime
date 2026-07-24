import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
interface RpcResponse { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export class StdioToolClient extends EventEmitter {
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #id = 0;
  #closed = false;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    super();
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) {
        this.#close(new Error("Tool protocol line exceeds 16 MiB."));
        child.kill("SIGTERM");
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) this.#receive(line);
      }
    });
    child.stderr.on("data", (chunk) => this.emit("log", chunk.toString("utf8")));
    child.once("exit", (code, signal) => this.#close(new Error(`Tool process exited (${code ?? signal ?? "unknown"}).`)));
    child.once("error", (error) => this.#close(error));
  }

  async request<T>(method: string, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.#closed) throw new Error("Tool process is closed.");
    const id = ++this.#id;
    const request: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        this.#pending.delete(id);
        cleanup();
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Request aborted."));
      };
      this.#pending.set(id, {
        resolve(value) { cleanup(); resolve(value as T); },
        reject(error) { cleanup(); reject(error); }
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      if (options.timeoutMs) timeout = setTimeout(() => {
        this.#pending.delete(id);
        cleanup();
        reject(new Error(`Tool request timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs);
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => error && abort());
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    try { await this.request("shutdown", undefined, { timeoutMs: 2_000 }); } catch {}
    this.child.kill("SIGTERM");
  }

  #receive(line: string): void {
    let message: RpcResponse & { method?: string; params?: unknown };
    try { message = JSON.parse(line) as typeof message; } catch {
      this.emit("log", `Invalid tool protocol line: ${line}`);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", { method: message.method, params: message.params });
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.emit("closed", error);
  }
}

export async function httpJsonRpc<T>(endpoint: string, method: string, params: unknown, options: { signal?: AbortSignal; token?: string } = {}): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: options.signal,
    redirect: "error"
  });
  if (!response.ok) throw new Error(`Remote tool returned HTTP ${response.status}.`);
  const payload = await readBoundedJsonResponse(response) as { result?: T; error?: { code: number; message: string } };
  if (payload.error) throw new Error(`${payload.error.code}: ${payload.error.message}`);
  return payload.result as T;
}

export async function readBoundedJsonResponse(response: Response, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new Error("Remote response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Remote JSON response exceeds ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(text); }
  catch { throw new Error("Remote response is not valid JSON."); }
}
