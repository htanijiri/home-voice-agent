import { afterEach, describe, expect, it } from "vitest";
import { OpusEncoder } from "../src/transports/xiaozhi/opus.js";
import { FakeLlm, FakeStt, FakeTts, said } from "./fakes.js";
import { startTestApp } from "./helpers.js";
import { callOta } from "./xiaozhi-client.js";
import { FakeMqttDevice } from "./xiaozhi-mqtt-client.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

const silent = () => {
  const e = new OpusEncoder(16000);
  const [f] = e.encodeAll(new Int16Array(960));
  e.close();
  return f!;
};

async function setup(stt = new FakeStt([said("日本で一番高い山は？")]), llm = new FakeLlm([{ text: "富士山です。" }])) {
  const t = await startTestApp({
    stt,
    tts: new FakeTts(),
    llm,
    configure: (c) => {
      c.server.deviceTransport = "mqtt";
      c.conversation.followUpSeconds = 0;
    },
  });
  cleanup.push(() => t.app.close());
  t.config.mqtt.publicEndpoint = `127.0.0.1:${t.app.mqtt!.mqttPort()}`;
  // 端末を承認して OTA から MQTT の設定を受け取る
  const first = await callOta(t.base, "aa:bb:cc:00:00:01", "client-m");
  t.app.devices.approveByCode(first.body.activation.code, new Date());
  const ota = await callOta(t.base, "aa:bb:cc:00:00:01", "client-m");
  return { ...t, mqttCfg: ota.body.mqtt as Record<string, any> };
}

describe("MQTT＋UDP の口", () => {
  it("OTA が MQTT の設定を返す（websocket は返さない）", async () => {
    const { mqttCfg } = await setup();
    expect(mqttCfg).toMatchObject({ username: "aa:bb:cc:00:00:01", publish_topic: "device-server", keepalive: 240 });
    expect(mqttCfg.password).toBeTruthy();
    expect(mqttCfg.client_id.length).toBeLessThanOrEqual(23);
  });

  it("誤ったパスワードでは接続できない", async () => {
    const { mqttCfg } = await setup();
    const dev = new FakeMqttDevice({ ...mqttCfg, password: "wrong" });
    await expect(dev.connect()).rejects.toBeTruthy();
    cleanup.push(() => dev.close());
  });

  it("hello で UDP の鍵を受け取り、暗号化した音声で会話が往復する", async () => {
    const { app, mqttCfg } = await setup();
    const dev = new FakeMqttDevice(mqttCfg);
    await dev.connect();
    cleanup.push(() => dev.close());
    await dev.openAudio();
    const hello = dev.json.find((m) => m.type === "hello")!;
    expect(hello.udp.key).toMatch(/^[0-9a-f]{32}$/);
    expect(hello.udp.nonce).toMatch(/^01[0-9a-f]{30}$/);
    dev.startListening();
    dev.sendAudio(silent());
    await dev.waitFor((m) => m.type === "tts" && m.state === "stop");
    expect(dev.json.find((m) => m.type === "stt")!.text).toBe("日本で一番高い山は？");
    expect(dev.audio.length).toBeGreaterThan(0);
    // 会話が終わるとサーバーから goodbye が来る
    await dev.waitFor((m) => m.type === "goodbye");
    expect(app.hub.isBusy("aa:bb:cc:00:00:01")).toBe(false);
  });

  it("同じシーケンス番号の音声パケット（再送）は捨てる", async () => {
    const stt = new FakeStt([said("こんにちは")]);
    const { mqttCfg } = await setup(stt, new FakeLlm([{ text: "こんにちは。" }]));
    const dev = new FakeMqttDevice(mqttCfg);
    await dev.connect();
    cleanup.push(() => dev.close());
    await dev.openAudio();
    dev.startListening();
    dev.sendAudio(silent());
    dev.replay(silent());
    dev.replay(silent());
    await dev.waitFor((m) => m.type === "tts" && m.state === "stop");
    expect(stt.streams[0]!.written).toBe(960);
  });

  it("接続したままにでき、会話のない時間にサーバーから JSON（notify など）を送れる", async () => {
    const { app, mqttCfg } = await setup();
    const dev = new FakeMqttDevice(mqttCfg);
    await dev.connect();
    cleanup.push(() => dev.close());
    await new Promise((r) => setTimeout(r, 50));
    const link = app.hub.getLink("aa:bb:cc:00:00:01");
    expect(link?.kind).toBe("mqtt");
    expect(link?.audioOpen).toBe(false);
    link!.sendJson({ type: "notify", audio_url: "http://x/a.ogg" });
    const n = await dev.waitFor((m) => m.type === "notify");
    expect(n.audio_url).toBe("http://x/a.ogg");
  });
});

describe("音声の通路が閉じた端末", () => {
  it("閉じたあとに listen start が来たら goodbye を返し、読み上げなどは送らない", async () => {
    const { mqttCfg, app } = await setup();
    const dev = new FakeMqttDevice(mqttCfg);
    await dev.connect();
    cleanup.push(() => dev.close());
    await dev.openAudio();
    const sid = dev.sessionId;
    dev.goodbye();
    await new Promise((r) => setTimeout(r, 50));
    dev.publish({ session_id: sid, type: "listen", state: "start", mode: "auto" });
    const bye = await dev.waitFor((m) => m.type === "goodbye");
    expect(bye.session_id).toBe(sid);
    // 閉じた端末へのセッションの出力は送られない
    const before = dev.json.length;
    const session = app.hub.getSession("aa:bb:cc:00:00:01")!;
    (session as unknown as { sink: { tts?: unknown; ttsStart(): void } }).sink.ttsStart();
    await new Promise((r) => setTimeout(r, 50));
    expect(dev.json.slice(before).some((m) => m.type === "tts")).toBe(false);
  });
});
