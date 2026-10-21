import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { createApp } from "../src/app/server.js";
import { loadConfig } from "../src/config.js";
import type { LanguageModel, SpeechToText, TextToSpeech } from "../src/core/ports.js";
import type { ToolRegistry } from "../src/core/tools/registry.js";
import { openDb } from "../src/db/db.js";
import { FakeClock } from "./fakes.js";

export function testConfig() {
  process.env.CONFIG_PATH = resolve(import.meta.dirname, "../config/config.example.toml");
  const cfg = loadConfig(resolve(import.meta.dirname, ".."));
  cfg.server.publicBaseUrl = "http://127.0.0.1:0";
  // 手元の server/data（実際のデータやファームウェア）に左右されないよう、毎回空の一時フォルダを使う
  cfg.server.dataDir = mkdtempSync(join(tmpdir(), "hva-test-"));
  cfg.mqtt.port = 0;
  cfg.mqtt.udpPort = 0;
  cfg.mqtt.udpPublicHost = "127.0.0.1";
  return cfg;
}

export async function startTestApp(opts: {
  stt: SpeechToText;
  tts: TextToSpeech;
  llm: LanguageModel;
  tools?: ToolRegistry;
  clock?: FakeClock;
  oidc?: import("../src/web/auth.js").OidcConfig;
  configure?: (cfg: ReturnType<typeof testConfig>) => void;
}) {
  const config = testConfig();
  opts.configure?.(config);
  const db = openDb(":memory:");
  const clock = opts.clock ?? new FakeClock();
  const app = createApp({
    config,
    db,
    clock,
    stt: opts.stt,
    tts: opts.tts,
    llm: opts.llm,
    tools: opts.tools,
    oidc: opts.oidc,
    promptsDir: resolve(import.meta.dirname, "../prompts"),
  });
  // 実際のポートが決まってから、OTA が返す WebSocket の URL を作り直す
  const port = await app.listen(0, "127.0.0.1");
  config.server.publicBaseUrl = `http://127.0.0.1:${port}`;
  const base = `http://127.0.0.1:${port}`;
  return { app, db, clock, base, wsUrl: `ws://127.0.0.1:${port}/xiaozhi/v1/`, config };
}

/** 承認済みの端末を作り、トークンを返す */
export function approvedDevice(app: Awaited<ReturnType<typeof startTestApp>>["app"], deviceId = "aa:bb:cc:dd:ee:ff") {
  const now = new Date();
  const row = app.devices.ensurePending(deviceId, "test-client", now);
  app.devices.approveByCode(row.activation_code!, now);
  return { deviceId, token: app.devices.issueToken(deviceId) };
}
