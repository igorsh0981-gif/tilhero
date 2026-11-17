/**
 * Минимальный клиент Redis (RESP2 поверх node:net) для тестов ts-common: у ts-common нет зависимости ioredis, а
 * лимитеру нужен только `call(command, ...args)` (интерфейс RateRedis).
 */
import { createConnection, type Socket } from "node:net";

type Reply = string | number | null | Reply[] | Error;

export class RespClient {
  private readonly sock: Socket;
  private buf = Buffer.alloc(0);
  private readonly waiting: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];

  constructor(url: string) {
    const u = new URL(url);
    this.sock = createConnection({ host: u.hostname, port: Number(u.port || 6379) });
    this.sock.on("data", (d) => this.onData(d));
    this.sock.on("error", (e) => {
      for (const w of this.waiting.splice(0)) w.reject(e);
    });
    const db = u.pathname.replace("/", "");
    if (db) this.call("SELECT", db).catch(() => undefined);
  }

  call(command: string, ...args: (string | number)[]): Promise<unknown> {
    const parts = [command, ...args].map((a) => Buffer.from(String(a), "utf8"));
    const head = `*${parts.length}\r\n`;
    const chunks = [Buffer.from(head)];
    for (const p of parts) chunks.push(Buffer.from(`$${p.length}\r\n`), p, Buffer.from("\r\n"));
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.sock.write(Buffer.concat(chunks));
    });
  }

  async quit(): Promise<void> {
    await this.call("QUIT").catch(() => undefined);
    this.sock.destroy();
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const r = this.parse(0);
      if (!r) return;
      this.buf = this.buf.subarray(r.end);
      const w = this.waiting.shift();
      if (!w) continue;
      if (r.value instanceof Error) w.reject(r.value);
      else w.resolve(r.value);
    }
  }

  private parse(at: number): { value: Reply; end: number } | null {
    const nl = this.buf.indexOf("\r\n", at);
    if (nl < 0) return null;
    const type = String.fromCharCode(this.buf[at]!);
    const line = this.buf.toString("utf8", at + 1, nl);
    const next = nl + 2;
    if (type === "+") return { value: line, end: next };
    if (type === "-") return { value: new Error(line), end: next };
    if (type === ":") return { value: Number(line), end: next };
    if (type === "$") {
      const n = Number(line);
      if (n < 0) return { value: null, end: next };
      if (this.buf.length < next + n + 2) return null;
      return { value: this.buf.toString("utf8", next, next + n), end: next + n + 2 };
    }
    if (type === "*") {
      const n = Number(line);
      if (n < 0) return { value: null, end: next };
      const items: Reply[] = [];
      let pos = next;
      for (let i = 0; i < n; i++) {
        const r = this.parse(pos);
        if (!r) return null;
        items.push(r.value);
        pos = r.end;
      }
      return { value: items, end: pos };
    }
    throw new Error(`RESP: unexpected ${type}`);
  }
}
