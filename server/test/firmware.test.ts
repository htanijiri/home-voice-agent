import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlm, FakeStt, FakeTts } from "./fakes.js";
import { approvedDevice, startTestApp } from "./helpers.js";
import { callOta } from "./xiaozhi-client.js";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

describe("ファームウェアの配布", () => {
  it("manifest があれば OTA の応答に新しい版と URL を載せ、そのファイルだけを配る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hva-fw-"));
    mkdirSync(join(dir, "firmware"));
    writeFileSync(join(dir, "firmware", "xiaozhi-2.5.2.2.bin"), Buffer.alloc(1024, 7));
    writeFileSync(join(dir, "firmware", "manifest.json"), JSON.stringify({ version: "2.5.2.2", file: "xiaozhi-2.5.2.2.bin" }));
    const t = await startTestApp({ stt: new FakeStt(), tts: new FakeTts(), llm: new FakeLlm([]), configure: (c) => (c.server.dataDir = dir) });
    cleanup.push(() => t.app.close());
    const { deviceId } = approvedDevice(t.app);
    const r = await callOta(t.base, deviceId, "test-client");
    expect(r.body.firmware).toEqual({ version: "2.5.2.2", url: `${t.base}/firmware/xiaozhi-2.5.2.2.bin` });
    const bin = await fetch(r.body.firmware.url);
    expect(bin.status).toBe(200);
    expect((await bin.arrayBuffer()).byteLength).toBe(1024);
    expect((await fetch(`${t.base}/firmware/manifest.json`)).status).toBe(404);
    expect((await fetch(`${t.base}/firmware/..%2Fapp.db`)).status).toBe(404);
  });

  it("manifest がなければ firmware を載せない", async () => {
    const t = await startTestApp({ stt: new FakeStt(), tts: new FakeTts(), llm: new FakeLlm([]) });
    cleanup.push(() => t.app.close());
    const { deviceId } = approvedDevice(t.app);
    expect((await callOta(t.base, deviceId, "test-client")).body.firmware).toBeUndefined();
  });
});
