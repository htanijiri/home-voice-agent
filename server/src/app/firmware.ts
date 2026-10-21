// 端末のファームウェアの配布（Wi-Fi 経由の更新）。データの置き場所の firmware/manifest.json に、配る版とファイル名を書く。
//   { "version": "2.5.2.2", "file": "xiaozhi-2.5.2.2.bin" }
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";

export interface FirmwareManifest {
  version: string;
  file: string;
}

export class FirmwareStore {
  constructor(private readonly dir: string) {}

  manifest(): FirmwareManifest | undefined {
    const p = join(this.dir, "manifest.json");
    if (!existsSync(p)) return undefined;
    try {
      const m = JSON.parse(readFileSync(p, "utf8")) as FirmwareManifest;
      if (!/^\d+(\.\d+)+$/.test(m.version) || basename(m.file) !== m.file) return undefined;
      if (!existsSync(join(this.dir, m.file))) return undefined;
      return m;
    } catch {
      return undefined;
    }
  }

  register(app: FastifyInstance) {
    app.get<{ Params: { file: string } }>("/firmware/:file", async (req, reply) => {
      const m = this.manifest();
      // manifest に書いたファイルだけを配る
      if (!m || req.params.file !== m.file) return reply.code(404).send();
      const p = join(this.dir, m.file);
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", statSync(p).size)
        .send(createReadStream(p));
    });
  }
}
