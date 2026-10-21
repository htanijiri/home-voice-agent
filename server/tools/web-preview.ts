// 確認画面の見た目を確かめるためのプレビュー（開発用）。架空のデータを入れ、偽の外部サービスで動かす。
//   npm run web-preview  → http://127.0.0.1:8090/dev/login を開く
import { resolve } from "node:path";
import { createLocalJWKSet } from "jose";
import { createApp } from "../src/app/server.js";
import { loadConfig } from "../src/config.js";
import { systemClock } from "../src/core/ports.js";
import { openDb } from "../src/db/db.js";
import { FakeLlm, FakeStt, FakeTts } from "../test/fakes.js";

process.env.CONFIG_PATH = resolve(import.meta.dirname, "../config/config.example.toml");
const config = loadConfig(resolve(import.meta.dirname, ".."));
const port = Number(process.env.PORT ?? 8090);
// 内蔵ブラウザは localhost で開くので、更新系の Origin の確認に合わせる
config.server.publicBaseUrl = `http://localhost:${port}`;
config.mqtt.port = 0;
config.mqtt.udpPort = 0;
const db = openDb(":memory:");
const app = createApp({
  config,
  db,
  clock: systemClock,
  stt: new FakeStt(),
  tts: new FakeTts(),
  llm: new FakeLlm([]),
  promptsDir: resolve(import.meta.dirname, "../prompts"),
  oidc: {
    clientId: "preview",
    clientSecret: "preview",
    authorizationEndpoint: "http://127.0.0.1/none",
    tokenEndpoint: "http://127.0.0.1/none",
    issuers: ["preview"],
    jwks: createLocalJWKSet({ keys: [] }),
    allowedEmails: ["preview@example.com"],
  },
});
const now = new Date();
for (const [n, note] of [["牛乳", "2本"], ["卵", ""], ["食パン", "6枚切り"], ["トイレットペーパー", ""], ["バナナ", ""]] as const) {
  app.shopping.add("home", n, note || undefined, now);
}
const bought = app.shopping.add("home", "ヨーグルト", undefined, now).item;
app.shopping.setStatus("home", bought.id, "bought", now);
const tomorrow8 = new Date(now.getTime() + 86_400_000);
tomorrow8.setHours(8, 0, 0, 0);
app.reminders.create("home", "ゴミ出し", { kind: "once", date: tomorrow8.toLocaleDateString("sv-SE"), time: "08:00" }, tomorrow8, now);
app.reminders.create("home", "燃えるゴミ", { kind: "weekly", weekdays: [1, 4], time: "07:30" }, tomorrow8, now);
app.reminders.create("home", "資源ゴミ（とても長い名前のリマインダーの表示を確かめるための例）", { kind: "monthly_nth", nths: [2, 4], weekday: 3, time: "08:00" }, tomorrow8, now);
app.turns.insert({ deviceId: "d", userText: "日本で一番高い山は？", assistantText: "富士山です。高さは3776メートルです。", outcome: "ok", timings: {} }, now);
app.devices.ensurePending("02:00:00:00:00:99", "c", now);
app.usage.add(now, "turns", 42);
app.usage.add(now, "stt_seconds", 600);
app.usage.add(now, "tts_chars", 5200);

app.http.get("/dev/login", async (_req, reply) => {
  const s = app.webAuth!.createSession("preview@example.com");
  reply.header("Set-Cookie", `hva_session=${s.id}; Path=/; HttpOnly; SameSite=Lax`);
  return reply.redirect("/");
});
await app.listen(port, "127.0.0.1");
console.log(`preview: http://127.0.0.1:${port}/dev/login`);
