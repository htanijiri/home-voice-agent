// 002：音量、夜間の音量、利用上限、会話の記録の削除、録音を残さないこと
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolumePolicy } from "../src/app/volume-policy.js";
import { LIMIT_MESSAGE } from "../src/app/server.js";
import { volumeTool } from "../src/core/tools/volume.js";
import { openDb } from "../src/db/db.js";
import { KvRepo } from "../src/db/kv-repo.js";
import { OpusEncoder } from "../src/transports/xiaozhi/opus.js";
import { FakeClock, FakeLlm, FakeStt, FakeTts, said } from "./fakes.js";
import { approvedDevice, startTestApp } from "./helpers.js";
import { FakeXiaozhiDevice } from "./xiaozhi-client.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

class FakeDevice {
  volume = 70;
  calls: number[] = [];
  async setVolume(v: number) {
    this.volume = v;
    this.calls.push(v);
  }
  async getVolume() {
    return this.volume;
  }
}

const silent = () => {
  const e = new OpusEncoder(16000);
  const [f] = e.encodeAll(new Int16Array(960));
  e.close();
  return f!;
};

describe("音量のツール", () => {
  const ctx = (device: FakeDevice) => ({ deviceId: "d", householdId: "h", now: new Date(), device });
  it("段階（0〜10）を、聞こえる範囲の音量に割り当てる（5 → 65、10 → 100、0 → 消音）", async () => {
    const d = new FakeDevice();
    expect(await volumeTool().run({ level: 5 }, ctx(d))).toMatchObject({ level: 5, volume: 65 });
    await volumeTool().run({ level: 10 }, ctx(d));
    expect(d.volume).toBe(100);
    await volumeTool().run({ level: 1 }, ctx(d));
    expect(d.volume).toBe(37);
    await volumeTool().run({ level: 0 }, ctx(d));
    expect(d.volume).toBe(0);
  });
  it("上げる・下げるは1段階ずつ。10 より上、0 より下にはならない", async () => {
    const d = new FakeDevice();
    d.volume = 65;
    await volumeTool().run({ change: "up" }, ctx(d));
    expect(d.volume).toBe(72);
    d.volume = 100;
    await volumeTool().run({ change: "up" }, ctx(d));
    expect(d.volume).toBe(100);
    d.volume = 37;
    await volumeTool().run({ change: "down" }, ctx(d));
    expect(d.volume).toBe(0);
  });
  it("段階と音量の変換（今の音量から段階を求める）", async () => {
    const { volumeToLevel } = await import("../src/core/tools/volume.js");
    expect(volumeToLevel(45)).toBe(2);
    expect(volumeToLevel(70)).toBe(6);
    expect(volumeToLevel(0)).toBe(0);
  });
  it("範囲外の段階はエラー", async () => {
    await expect(volumeTool().run({ level: 11 }, ctx(new FakeDevice()))).rejects.toThrow();
  });
});

describe("運用から指定した音量", () => {
  it("次の apply で一度だけ設定し、その端末には繰り返さない", async () => {
    const kv = new KvRepo(openDb(":memory:"));
    const p = new VolumePolicy({ day: 65, night: 50, nightStart: "22:00", nightEnd: "07:00" }, "Asia/Tokyo", kv);
    const d = new FakeDevice();
    p.request(60);
    await p.apply("dev", d, new Date("2026-10-21T10:00:00+09:00"));
    expect(d.volume).toBe(60);
    d.volume = 70;
    await p.apply("dev", d, new Date("2026-10-21T10:01:00+09:00"));
    expect(d.volume).toBe(70);
  });
});

describe("夜間の音量", () => {
  const cfg = { day: 70, night: 40, nightStart: "22:00", nightEnd: "07:00" };
  it("夜に入ると、その時の音量を覚えて夜間の音量にし、朝に戻す", async () => {
    const kv = new KvRepo(openDb(":memory:"));
    const p = new VolumePolicy(cfg, "Asia/Tokyo", kv);
    const d = new FakeDevice();
    await p.apply("dev", d, new Date("2026-10-20T15:00:00+09:00")); // 昼：初回は変えない
    expect(d.calls).toEqual([]);
    d.volume = 80; // 昼に声で上げた
    await p.apply("dev", d, new Date("2026-10-20T22:30:00+09:00"));
    expect(d.volume).toBe(40);
    d.volume = 60; // 夜に声で上げた
    await p.apply("dev", d, new Date("2026-10-20T23:00:00+09:00")); // 同じ夜：変えない
    expect(d.volume).toBe(60);
    await p.apply("dev", d, new Date("2026-10-21T07:05:00+09:00"));
    expect(d.volume).toBe(80);
  });
  it("22:00〜7:00 を夜とみなす（日をまたぐ）", () => {
    const p = new VolumePolicy(cfg, "Asia/Tokyo", new KvRepo(openDb(":memory:")));
    expect(p.periodAt(new Date("2026-10-20T21:59:00+09:00"))).toBe("day");
    expect(p.periodAt(new Date("2026-10-20T22:00:00+09:00"))).toBe("night");
    expect(p.periodAt(new Date("2026-10-21T06:59:00+09:00"))).toBe("night");
    expect(p.periodAt(new Date("2026-10-21T07:00:00+09:00"))).toBe("day");
  });
});

describe("サーバー全体での確認", () => {
  it("声で音量を変えると、端末の MCP の set_volume が呼ばれる", async () => {
    const llm = new FakeLlm([{ toolUses: [{ name: "set_volume", input: { level: 3 } }] }, { text: "音量を3にしました。" }]);
    const t = await startTestApp({
      stt: new FakeStt([said("音量を3にして")]),
      tts: new FakeTts(),
      llm,
      configure: (c) => (c.conversation.followUpSeconds = 0),
    });
    cleanup.push(() => t.app.close());
    const { deviceId, token } = approvedDevice(t.app);
    const dev = new FakeXiaozhiDevice(t.wsUrl, deviceId, token);
    await dev.connect();
    dev.startListening();
    dev.sendAudio(silent());
    await dev.waitFor((m) => m.type === "tts" && m.state === "stop");
    expect(dev.volume).toBe(51); // 段階 3 → 30 + 7×3
  });

  it("1日の上限に達していたら、LLM を呼ばずに上限の案内を返す", async () => {
    const llm = new FakeLlm([{ text: "呼ばれない。" }]);
    const clock = new FakeClock();
    const t = await startTestApp({
      stt: new FakeStt([said("こんにちは")]),
      tts: new FakeTts(),
      llm,
      clock,
      configure: (c) => {
        c.conversation.followUpSeconds = 0;
        c.limits.dailyTurns = 1;
      },
    });
    cleanup.push(() => t.app.close());
    t.app.usage.add(clock.now(), "turns", 1);
    const { deviceId, token } = approvedDevice(t.app);
    const dev = new FakeXiaozhiDevice(t.wsUrl, deviceId, token);
    await dev.connect();
    dev.startListening();
    dev.sendAudio(silent());
    const s = await dev.waitFor((m) => m.state === "sentence_start");
    expect(s.text).toBe(LIMIT_MESSAGE);
    expect(llm.requests).toHaveLength(0);
  });

  it("30日より古い会話の記録は、毎日の掃除で消える", async () => {
    const clock = new FakeClock(new Date("2026-11-30T03:59:00+09:00"));
    const t = await startTestApp({ stt: new FakeStt(), tts: new FakeTts(), llm: new FakeLlm([]), clock });
    cleanup.push(() => t.app.close());
    const rec = { deviceId: "d", userText: "a", assistantText: "b", outcome: "ok" as const, timings: {} };
    t.app.turns.insert(rec, new Date("2026-10-30T12:00:00+09:00")); // 31日前
    t.app.turns.insert(rec, new Date("2026-11-20T12:00:00+09:00"));
    clock.t = new Date("2026-11-30T04:00:00+09:00");
    await t.app.jobs.tick();
    expect(t.app.turns.list()).toHaveLength(1);
  });

  it("会話のあと、データの置き場所に音声のファイルが残らず、ログにも音声が出ない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hva-"));
    const logs: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    cleanup.push(() => {
      process.stdout.write = orig;
    });
    const t = await startTestApp({
      stt: new FakeStt([said("こんにちは")]),
      tts: new FakeTts(),
      llm: new FakeLlm([{ text: "こんにちは。" }]),
      configure: (c) => {
        c.server.dataDir = dir;
        c.conversation.followUpSeconds = 0;
      },
    });
    cleanup.push(() => t.app.close());
    const { deviceId, token } = approvedDevice(t.app);
    const dev = new FakeXiaozhiDevice(t.wsUrl, deviceId, token);
    await dev.connect();
    dev.startListening();
    for (let i = 0; i < 10; i++) dev.sendAudio(silent());
    await dev.waitFor((m) => m.type === "tts" && m.state === "stop");
    await dev.waitClosed();
    expect(readdirSync(dir)).toEqual([]);
    const joined = logs.join("");
    expect(joined).not.toMatch(/OggS|RIFF/);
    expect(joined).not.toContain("こんにちは"); // 会話の本文もログに出さない
  });
});
