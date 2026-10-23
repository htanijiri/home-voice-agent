// サーバー全体の組み立て。外部サービスの実装を差し替えられるようにして、テストでも同じものを使う。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { Orchestrator } from "../core/orchestrator.js";
import type { Clock, LanguageModel, SpeechToText, TextToSpeech } from "../core/ports.js";
import { localDateString } from "../core/time.js";
import { makeTurnNote } from "../core/turn-note.js";
import { ToolRegistry } from "../core/tools/registry.js";
import type { Db } from "../db/db.js";
import { DevicesRepo } from "../db/devices-repo.js";
import { TurnsRepo, voiceEndToAudio } from "../db/turns-repo.js";
import { UsageRepo } from "../db/usage-repo.js";
import { errorFields, log } from "../log.js";
import { registerOta } from "../transports/xiaozhi/ota.js";
import { attachWebSocket, WS_PATH } from "../transports/xiaozhi/websocket.js";
import { type MqttUdpServer, startMqttUdp } from "../transports/xiaozhi/mqtt-udp.js";
import { KvRepo } from "../db/kv-repo.js";
import { volumeTool } from "../core/tools/volume.js";
import { shoppingTools } from "../core/tools/shopping.js";
import { ShoppingRepo } from "../db/shopping-repo.js";
import { RemindersRepo } from "../db/reminders-repo.js";
import { reminderTools } from "../core/tools/reminders.js";
import { NotifyAudioStore } from "./notify-audio.js";
import { ReminderScheduler } from "./reminder-scheduler.js";
import { DeviceHub } from "./hub.js";
import { FirmwareStore } from "./firmware.js";
import { type OidcConfig, WebAuth } from "../web/auth.js";
import { registerWeb } from "../web/routes.js";
import { DEFAULT_LOCAL_VAD } from "../core/local-vad.js";
import { ChangeFeed } from "./change-feed.js";
import { JobRunner, type Job } from "./jobs.js";
import { VolumePolicy } from "./volume-policy.js";

export interface AppDeps {
  config: AppConfig;
  db: Db;
  stt: SpeechToText;
  tts: TextToSpeech;
  llm: LanguageModel;
  clock: Clock;
  /** 追加のツール（003 以降） */
  tools?: ToolRegistry;
  promptsDir?: string;
  /** 確認画面のログイン（Google）。なければ確認画面は使えない */
  oidc?: OidcConfig;
}

export interface App {
  http: FastifyInstance;
  hub: DeviceHub;
  devices: DevicesRepo;
  turns: TurnsRepo;
  usage: UsageRepo;
  tools: ToolRegistry;
  webAuth?: WebAuth;
  kv: KvRepo;
  shopping: ShoppingRepo;
  reminders: RemindersRepo;
  /** 買い物リスト・リマインダーの変更の通知 */
  changes: ChangeFeed;
  scheduler: ReminderScheduler;
  jobs: JobRunner;
  volume: VolumePolicy;
  listen(port?: number, host?: string): Promise<number>;
  /** MQTT＋UDP の口（listen のあとに使える） */
  mqtt?: MqttUdpServer;
  close(): Promise<void>;
}

export const LIMIT_MESSAGE = "今日の利用上限に達しました。また明日話しかけてください。";

export function wsUrlFrom(publicBaseUrl: string): string {
  const u = new URL(publicBaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = WS_PATH;
  return u.toString();
}

export function createApp(deps: AppDeps): App {
  const { config, db, clock } = deps;
  const tz = config.household.timezone;
  const devices = new DevicesRepo(db);
  const turns = new TurnsRepo(db);
  const usage = new UsageRepo(db, tz);
  const kv = new KvRepo(db);
  const changes = new ChangeFeed();
  const shopping = new ShoppingRepo(db, (hh) => changes.notify(hh, "shopping"));
  const tools = deps.tools ?? new ToolRegistry();
  const reminders = new RemindersRepo(db, tz, (hh) => changes.notify(hh, "reminders"));
  tools.register(volumeTool(), ...shoppingTools(shopping), ...reminderTools(reminders, tz));
  let scheduler: ReminderScheduler | undefined;
  const volume = new VolumePolicy(config.volume, tz, kv);

  const systemPrompt = readFileSync(resolve(deps.promptsDir ?? "prompts", "system.md"), "utf8");
  const orchestrator = new Orchestrator(
    deps.llm,
    tools,
    systemPrompt,
    makeTurnNote(shopping, config.household.id, tz),
    clock,
    {
      firstSentenceTimeoutMs: config.conversation.firstSentenceTimeoutSeconds * 1000,
      totalTimeoutMs: config.conversation.totalTimeoutSeconds * 1000,
      maxToolRounds: 4,
    },
    {
      llm(_model, u) {
        const now = clock.now();
        usage.add(now, "llm_input_tokens", u.inputTokens);
        usage.add(now, "llm_output_tokens", u.outputTokens);
        usage.add(now, "llm_cache_read_tokens", u.cacheReadTokens);
        usage.add(now, "llm_cache_write_tokens", u.cacheWriteTokens);
      },
    },
  );

  const hub = new DeviceHub({
    stt: deps.stt,
    tts: deps.tts,
    orchestrator,
    clock,
    householdId: config.household.id,
    sinkTiming: {
      startDelayMs: config.tts.startDelayMs ?? 200,
      leadingSilenceMs: config.tts.leadingSilenceMs ?? 60,
    },
    config: {
      followUpSeconds: config.conversation.followUpSeconds,
      speechStartTimeoutSeconds: config.conversation.speechStartTimeoutSeconds,
      maxUtteranceSeconds: config.conversation.maxUtteranceSeconds,
      contextKeepMinutes: config.conversation.contextKeepMinutes,
      maxHistoryTurns: config.conversation.maxHistoryTurns,
      localVad: {
        ratio: config.conversation.localVadRatio ?? DEFAULT_LOCAL_VAD.ratio,
        minRms: config.conversation.localVadMinRms ?? DEFAULT_LOCAL_VAD.minRms,
        startMs: config.conversation.localVadStartMs ?? DEFAULT_LOCAL_VAD.startMs,
        endMs: config.conversation.localVadEndMs ?? DEFAULT_LOCAL_VAD.endMs,
      },
    },
    hooks: {
      checkLimit: () =>
        usage.today(clock.now(), "turns") >= config.limits.dailyTurns ? LIMIT_MESSAGE : undefined,
      onTurn: (rec) => {
        const now = clock.now();
        try {
          turns.insert(rec, now);
          if (rec.outcome === "ok" || rec.outcome === "error") usage.add(now, "turns", 1);
        } catch (err) {
          log.error("record turn failed", errorFields(err));
        }
        log.info("turn", {
          outcome: rec.outcome,
          errorKind: rec.errorKind,
          msTotal: rec.timings.firstAudioAt && rec.timings.speechEndAt ? rec.timings.firstAudioAt - rec.timings.speechEndAt : undefined,
          msVoiceEndToAudio: voiceEndToAudio(rec.timings) ?? undefined,
        });
      },
      pendingNotes: () => scheduler?.pendingNotes(),
      ttsUsage: (chars) => usage.add(clock.now(), "tts_chars", chars),
      sttUsage: (sec) => usage.add(clock.now(), "stt_seconds", sec),
    },
  });

  // 端末とつながったら、時間帯に合わせて音量を切り替える
  hub.on((e) => {
    if (e.type === "activity" && e.what === "hello") {
      const mcp = hub.getMcp(e.deviceId);
      if (mcp) void volume.apply(e.deviceId, mcp, clock.now());
    }
  });

  const notifyAudio = new NotifyAudioStore();
  scheduler = new ReminderScheduler(reminders, hub, deps.tts, notifyAudio, clock, {
    tz,
    publicBaseUrl: () => config.server.publicBaseUrl,
    retryMinutes: 5,
    maxLateMinutes: 120,
    beforeNotify: async (deviceId) => {
      const mcp = hub.getMcp(deviceId);
      if (mcp) await volume.apply(deviceId, mcp, clock.now());
    },
  });

  const jobs: Job[] = [
    {
      // 夜間・昼の音量の切り替え（常時つながっている端末）。切り替わったときだけ送る
      name: "volume-period",
      run(now) {
        for (const id of hub.onlineDevices()) {
          const mcp = hub.getMcp(id);
          if (mcp && hub.getLink(id)?.kind === "mqtt") void volume.apply(id, mcp, now);
        }
      },
    },
    {
      name: "retention",
      at: "04:00",
      runOnStart: true,
      run(now) {
        const cutoff = new Date(now.getTime() - config.retention.conversationDays * 86_400_000);
        const n = turns.deleteOlderThan(cutoff);
        if (n) log.info("old turns deleted", { count: n });
        shopping.purge(now);
      },
    },
  ];
  const jobRunner = new JobRunner(jobs, clock, tz);

  const http = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const firmware = new FirmwareStore(resolve(config.server.dataDir, "firmware"));
  firmware.register(http);
  notifyAudio.register(http);
  const webAuth = deps.oidc
    ? new WebAuth(db, deps.oidc, () => `${config.server.publicBaseUrl}/auth/callback`)
    : undefined;
  if (webAuth) {
    http.register(async (scope) => registerWeb(scope, { shopping, reminders, devices, turns, usage, changes }, webAuth, config, clock));
    jobs.push({ name: "web-sessions", at: "04:00", run: (now) => webAuth.purge(now) });
  } else {
    http.get("/", async (_req, reply) =>
      reply.type("text/html; charset=utf-8").send("<p>確認画面のログインの設定（GOOGLE_OAUTH_CLIENT_ID など）がありません。</p>"),
    );
  }
  http.get("/healthz", async () => ({ ok: true, day: localDateString(clock.now(), tz) }));
  registerOta(http, devices, clock, {
    transport: () => config.server.deviceTransport,
    mqtt: () => ({ endpoint: config.mqtt.publicEndpoint, clientIdPrefix: "hva_" }),
    firmware: () => {
      const m = firmware.manifest();
      return m ? { version: m.version, url: `${config.server.publicBaseUrl}/firmware/${m.file}` } : undefined;
    },
    websocketUrl: () => wsUrlFrom(config.server.publicBaseUrl),
    timezoneOffsetMinutes: 540,
  });
  const wss = attachWebSocket(http.server, hub, devices);

  const app: App = {
    http,
    hub,
    devices,
    turns,
    usage,
    tools,
    webAuth,
    kv,
    shopping,
    reminders,
    changes,
    scheduler,
    jobs: jobRunner,
    volume,
    async listen(port = config.server.httpPort, host = "0.0.0.0") {
      await http.listen({ port, host });
      app.mqtt = await startMqttUdp(hub, devices, {
        mqttPort: config.mqtt.port,
        udpPort: config.mqtt.udpPort,
        udpPublicHost: config.mqtt.udpPublicHost,
        udpBindHost: process.env.UDP_BIND_HOST,
      });
      jobRunner.start();
      scheduler!.start();
      const addr = http.server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    async close() {
      jobRunner.stop();
      scheduler!.stop();
      hub.close();
      await app.mqtt?.close();
      // 端末との WebSocket の接続を切ってから閉じる（切らないと close が終わらない）
      for (const c of wss.clients) c.terminate();
      wss.close();
      http.server.closeAllConnections();
      await http.close();
    },
  };
  return app;
}
