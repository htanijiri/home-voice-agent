// サーバーの起動。設定と秘密情報を読み、実際の外部サービスにつなぐ。
import { resolve } from "node:path";
import { AnthropicLlm } from "./adapters/llm-anthropic.js";
import { GoogleStt } from "./adapters/stt-google.js";
import { GoogleTts } from "./adapters/tts-google.js";
import { createApp } from "./app/server.js";
import { loadConfig, loadDotEnv, loadSecrets } from "./config.js";
import { systemClock } from "./core/ports.js";
import { openDb } from "./db/db.js";
import { log } from "./log.js";
import { googleOidc } from "./web/auth.js";

loadDotEnv(resolve(process.cwd(), ".env"));
const config = loadConfig();
const secrets = loadSecrets();
if (!secrets.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません（server/.env）");
if (!secrets.googleCloudProject) throw new Error("GOOGLE_CLOUD_PROJECT が設定されていません（server/.env）");
// クラウドでは、サービスアカウントの鍵を秘密情報（GOOGLE_CREDENTIALS_JSON）で受け取り、一時ファイルにする
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "gcp-"));
  const path = resolve(dir, "sa.json");
  writeFileSync(path, process.env.GOOGLE_CREDENTIALS_JSON, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  delete process.env.GOOGLE_CREDENTIALS_JSON;
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

const db = openDb(resolve(config.server.dataDir, "app.db"));
const app = createApp({
  config,
  db,
  clock: systemClock,
  stt: new GoogleStt({ projectId: secrets.googleCloudProject, ...config.stt }),
  tts: new GoogleTts(config.tts),
  llm: new AnthropicLlm({ apiKey: secrets.anthropicApiKey, ...config.llm }),
  oidc:
    secrets.googleOauthClientId && secrets.googleOauthClientSecret
      ? googleOidc(secrets.googleOauthClientId, secrets.googleOauthClientSecret, secrets.webAllowedEmails)
      : undefined,
});
if (!secrets.googleOauthClientId) log.warn("確認画面のログインの設定がないため、確認画面は使えません");
const port = await app.listen();
log.info("server started", { port, transport: config.server.deviceTransport });

const shutdown = async () => {
  log.info("shutting down");
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
