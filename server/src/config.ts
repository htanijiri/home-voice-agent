// 設定（config/config.toml）と秘密情報（.env）を読み込む。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";

export interface AppConfig {
  server: {
    httpPort: number;
    publicBaseUrl: string;
    deviceTransport: "websocket" | "mqtt";
    dataDir: string;
  };
  mqtt: { publicEndpoint: string; port: number; udpPublicHost: string; udpPort: number };
  llm: { model: string; maxTokens: number; effort: "low" | "medium" | "high" };
  stt: { location: string; model: string; languageCode: string };
  tts: {
    voice: string;
    languageCode: string;
    speakingRate: number;
    /** tts start から最初の音声を送るまで待つ時間（ミリ秒） */
    startDelayMs?: number;
    /** 読み上げの先頭に足す無音（ミリ秒） */
    leadingSilenceMs?: number;
  };
  conversation: {
    followUpSeconds: number;
    speechStartTimeoutSeconds: number;
    maxUtteranceSeconds: number;
    contextKeepMinutes: number;
    maxHistoryTurns: number;
    firstSentenceTimeoutSeconds: number;
    totalTimeoutSeconds: number;
  };
  limits: { dailyTurns: number };
  volume: { day: number; night: number; nightStart: string; nightEnd: string };
  retention: { conversationDays: number };
  household: { id: string; timezone: string };
  pricing: import("./report/cost.js").Pricing;
}

export interface Secrets {
  anthropicApiKey?: string;
  googleCloudProject?: string;
  googleOauthClientId?: string;
  googleOauthClientSecret?: string;
  webAllowedEmails: string[];
}

/** .env を process.env に読み込む（既に設定されている値は上書きしない） */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = raw!.replace(/^["']|["']$/g, "");
  }
}

export function loadConfig(baseDir = process.cwd()): AppConfig {
  const path = process.env.CONFIG_PATH ?? resolve(baseDir, "config/config.toml");
  const fallback = resolve(baseDir, "config/config.example.toml");
  const text = readFileSync(existsSync(path) ? path : fallback, "utf8");
  const cfg = parse(text) as unknown as AppConfig;
  cfg.server.dataDir = resolve(baseDir, process.env.DATA_DIR ?? cfg.server.dataDir);
  // クラウドでは、URL や接続先を環境変数で上書きする（fly.toml）
  const e = process.env;
  if (e.PUBLIC_BASE_URL) cfg.server.publicBaseUrl = e.PUBLIC_BASE_URL;
  if (e.DEVICE_TRANSPORT === "mqtt" || e.DEVICE_TRANSPORT === "websocket") cfg.server.deviceTransport = e.DEVICE_TRANSPORT;
  if (e.MQTT_PUBLIC_ENDPOINT) cfg.mqtt.publicEndpoint = e.MQTT_PUBLIC_ENDPOINT;
  if (e.UDP_PUBLIC_HOST) cfg.mqtt.udpPublicHost = e.UDP_PUBLIC_HOST;
  return cfg;
}

export function loadSecrets(): Secrets {
  const e = process.env;
  return {
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    googleCloudProject: e.GOOGLE_CLOUD_PROJECT || undefined,
    googleOauthClientId: e.GOOGLE_OAUTH_CLIENT_ID || undefined,
    googleOauthClientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
    webAllowedEmails: (e.WEB_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
