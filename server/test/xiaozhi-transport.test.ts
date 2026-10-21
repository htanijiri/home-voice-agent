import { afterEach, describe, expect, it } from "vitest";
import { OpusEncoder } from "../src/transports/xiaozhi/opus.js";
import { FakeLlm, FakeStt, FakeTts, said } from "./fakes.js";
import { approvedDevice, startTestApp } from "./helpers.js";
import { callActivate, callOta, FakeXiaozhiDevice } from "./xiaozhi-client.js";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function start(
  llm = new FakeLlm([{ text: "富士山です。" }]),
  stt = new FakeStt([said("日本で一番高い山は？")]),
  tts = new FakeTts(),
) {
  const t = await startTestApp({ stt, tts, llm, configure: (c) => (c.conversation.followUpSeconds = 0) });
  cleanup.push(() => t.app.close());
  return t;
}

/** 16kHz・60ms の無音の Opus フレーム */
function silentOpus(): Buffer {
  const enc = new OpusEncoder(16000);
  const [f] = enc.encodeAll(new Int16Array(960));
  enc.close();
  return f!;
}

describe("OTA の口", () => {
  it("未承認の端末には6桁の承認番号を返し、接続先は返さない", async () => {
    const { base } = await start();
    const r = await callOta(base, "11:22:33:44:55:66", "client-a");
    expect(r.status).toBe(200);
    expect(r.body.activation.code).toMatch(/^\d{6}$/);
    expect(r.body.activation.challenge).toBeTruthy();
    expect(r.body.websocket).toBeUndefined();
    expect(r.body.server_time.timestamp).toBeTypeOf("number");
    expect(await callActivate(base, "11:22:33:44:55:66", "client-a")).toBe(202);
  });

  it("承認すると /activate が 200 になり、OTA が WebSocket の URL とトークンを返す", async () => {
    const { base, app, wsUrl } = await start();
    const first = await callOta(base, "11:22:33:44:55:66", "client-a");
    app.devices.approveByCode(first.body.activation.code, new Date());
    expect(await callActivate(base, "11:22:33:44:55:66", "client-a")).toBe(200);
    const second = await callOta(base, "11:22:33:44:55:66", "client-a");
    expect(second.body.activation).toBeUndefined();
    expect(second.body.websocket.url).toBe(wsUrl);
    expect(second.body.websocket.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
  });

  it("Client-Id が変わったら、承認をやり直す", async () => {
    const { base, app } = await start();
    const first = await callOta(base, "11:22:33:44:55:66", "client-a");
    app.devices.approveByCode(first.body.activation.code, new Date());
    const other = await callOta(base, "11:22:33:44:55:66", "client-b");
    expect(other.body.activation.code).toMatch(/^\d{6}$/);
    expect(other.body.websocket).toBeUndefined();
  });

  it("番号を間違えても承認されない", async () => {
    const { base, app } = await start();
    const first = await callOta(base, "11:22:33:44:55:66", "client-a");
    const wrong = first.body.activation.code === "000000" ? "111111" : "000000";
    expect(app.devices.approveByCode(wrong, new Date())).toBeUndefined();
    expect(await callActivate(base, "11:22:33:44:55:66", "client-a")).toBe(202);
  });
});

describe("WebSocket の口", () => {
  it("トークンがない・間違っている接続を拒否する", async () => {
    const { app, wsUrl } = await start();
    const { deviceId } = approvedDevice(app);
    await expect(new FakeXiaozhiDevice(wsUrl, deviceId, "wrong-token").connect()).rejects.toThrow(/401/);
    await expect(new FakeXiaozhiDevice(wsUrl, deviceId, "").connect()).rejects.toThrow();
    await expect(new FakeXiaozhiDevice(wsUrl, "99:99:99:99:99:99", "x").connect()).rejects.toThrow(/401/);
  });

  it("hello → listen start → 音声 → stt / tts start / sentence_start / 音声 / tts stop → 切断", async () => {
    const { app, wsUrl } = await start();
    const { deviceId, token } = approvedDevice(app);
    const dev = new FakeXiaozhiDevice(wsUrl, deviceId, token);
    await dev.connect();
    const hello = dev.json.find((m) => m.type === "hello")!;
    expect(hello).toMatchObject({ transport: "websocket", audio_params: { format: "opus", sample_rate: 24000, frame_duration: 60 } });
    dev.startListening();
    dev.sendAudio(silentOpus());
    await dev.waitFor((m) => m.type === "tts" && m.state === "stop");
    await dev.waitClosed();
    const types = dev.json.map((m) => (m.type === "tts" ? `tts:${m.state}` : m.type));
    expect(types).toEqual(expect.arrayContaining(["hello", "stt", "llm", "tts:start", "tts:sentence_start", "tts:stop"]));
    expect(dev.json.find((m) => m.type === "stt")!.text).toBe("日本で一番高い山は？");
    expect(dev.json.find((m) => m.state === "sentence_start")!.text).toBe("富士山です。");
    expect(dev.audio.length).toBeGreaterThan(0);
    expect(app.turns.list()[0]).toMatchObject({ outcome: "ok", user_text: "日本で一番高い山は？" });
  });

  it("listen start の前に届いた音声は認識に回さない", async () => {
    const stt = new FakeStt([said("こんにちは")]);
    const { app, wsUrl } = await start(new FakeLlm([{ text: "こんにちは。" }]), stt);
    const { deviceId, token } = approvedDevice(app);
    const dev = new FakeXiaozhiDevice(wsUrl, deviceId, token);
    cleanup.push(async () => dev.close());
    await dev.connect();
    dev.sendAudio(silentOpus());
    await new Promise((r) => setTimeout(r, 100));
    expect(stt.streams).toHaveLength(0);
  });

  it("読み上げ中の abort で音声の送信が止まる", async () => {
    const long = "これはとても長い返事です。".repeat(20);
    // 1文 1 秒の音声にする
    const { app, wsUrl } = await start(new FakeLlm([{ text: long }]), undefined, new FakeTts(24000));
    const { deviceId, token } = approvedDevice(app);
    const dev = new FakeXiaozhiDevice(wsUrl, deviceId, token);
    cleanup.push(async () => dev.close());
    await dev.connect();
    dev.startListening();
    dev.sendAudio(silentOpus());
    await dev.waitFor((m) => m.type === "tts" && m.state === "start");
    dev.send({ type: "abort", reason: "wake_word_detected" });
    await new Promise((r) => setTimeout(r, 200));
    const n = dev.audio.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(dev.audio.length).toBe(n);
    expect(dev.json.some((m) => m.type === "tts" && m.state === "stop")).toBe(false);
  });
});

describe("会話を終えたあとのメッセージ", () => {
  it("切断（goodbye）のあとに届いた listen start は受け付けない", async () => {
    const { FakeLlm: L, FakeStt: S, FakeTts: T, said: sd } = await import("./fakes.js");
    const { startTestApp: start2 } = await import("./helpers.js");
    const stt = new S([sd("こんにちは")]);
    const t = await start2({ stt, tts: new T(), llm: new L([{ text: "こんにちは。" }]), configure: (c) => (c.conversation.followUpSeconds = 0) });
    cleanup.push(() => t.app.close());
    const { approvedDevice: ad } = await import("./helpers.js");
    const { deviceId } = ad(t.app);
    // 音声のやり取りが閉じた状態の端末から listen start が届いても、聞き取りを始めない
    t.app.hub.onJson(deviceId, { type: "listen", state: "start", mode: "auto" });
    expect(stt.streams).toHaveLength(0);
  });
});
