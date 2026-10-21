// 通知の音声（Ogg Opus）を短い間だけメモリに置き、1回だけ取り出せる URL で配る。ディスクには書かない。
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

interface Entry {
  ogg: Buffer;
  expiresAt: number;
}

export class NotifyAudioStore {
  private readonly items = new Map<string, Entry>();
  constructor(private readonly ttlMs = 5 * 60_000) {}

  put(ogg: Buffer): string {
    this.sweep();
    const token = randomBytes(18).toString("base64url");
    this.items.set(token, { ogg, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  take(token: string): Buffer | undefined {
    const e = this.items.get(token);
    this.items.delete(token);
    if (!e || e.expiresAt < Date.now()) return undefined;
    return e.ogg;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.items) if (v.expiresAt < now) this.items.delete(k);
  }

  register(app: FastifyInstance) {
    app.get<{ Params: { token: string } }>("/notify/audio/:token", async (req, reply) => {
      const token = req.params.token.replace(/\.ogg$/, "");
      const ogg = this.take(token);
      if (!ogg) return reply.code(404).send();
      return reply.header("Content-Type", "audio/ogg").header("Cache-Control", "no-store").send(ogg);
    });
  }
}
