import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { reminderTools } from "../src/core/tools/reminders.js";
import { openDb } from "../src/db/db.js";
import { RemindersRepo } from "../src/db/reminders-repo.js";
import { OpusEncoder } from "../src/transports/xiaozhi/opus.js";
import { FakeClock, FakeLlm, FakeStt, FakeTts, said } from "./fakes.js";
import { startTestApp } from "./helpers.js";
import { callOta } from "./xiaozhi-client.js";
import { FakeMqttDevice } from "./xiaozhi-mqtt-client.js";

const TZ = "Asia/Tokyo";
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function toolsSetup(now = new Date("2026-10-20T10:00:00+09:00")) {
  const repo = new RemindersRepo(openDb(":memory:"), TZ);
  const reg = new ToolRegistry().register(...reminderTools(repo, TZ));
  const call = async (name: string, input: unknown) => {
    const r = await reg.run(name, input, { deviceId: "d", householdId: "home", now });
    return { ...r, value: JSON.parse(r.content) };
  };
  return { repo, call };
}

describe("リマインダーのツール", () => {
  it("明日の午前8時にゴミ出し → 翌日 08:00 JST で保存され、日時を言い直せる", async () => {
    const { repo, call } = toolsSetup();
    const r = await call("reminder_create", { title: "ゴミ出し", when: { type: "once", date: { relative: "tomorrow" }, time: "08:00" } });
    expect(r.value.created).toMatchObject({ title: "ゴミ出し", next: "10月21日（水）午前8時", recurring: false });
    expect(repo.active("home")[0]!.next_fire_at).toBe(new Date("2026-10-21T08:00:00+09:00").toISOString());
  });

  it("時刻がないと ask_user を返して保存しない", async () => {
    const { repo, call } = toolsSetup();
    const r = await call("reminder_create", { title: "ゴミ出し", when: { type: "once", date: { weekday: 5 } } });
    expect(r.isError).toBe(true);
    expect(r.value.error).toMatch(/^ask_user: 何時/);
    expect(repo.active("home")).toHaveLength(0);
  });

  it("一覧・変更・削除", async () => {
    const { repo, call } = toolsSetup();
    await call("reminder_create", { title: "燃えるゴミ", when: { type: "weekly", weekdays: [1, 4], time: "07:30" } });
    await call("reminder_create", { title: "歯医者", when: { type: "once", date: { month: 11, day: 2 }, time: "15:00" } });
    const list = await call("reminder_list", {});
    expect(list.value.total).toBe(2);
    expect(list.value.reminders[0]).toMatchObject({ title: "燃えるゴミ", when: "毎週月曜日と木曜日の午前7時30分" });
    const up = await call("reminder_update", { title: "歯医者", when: { type: "once", date: { month: 11, day: 2 }, time: "16:00" } });
    expect(up.value.updated.next).toBe("11月2日（月）午後4時");
    expect((await call("reminder_delete", { title: "歯医者" })).value).toMatchObject({ deleted: { title: "歯医者" } });
    expect(repo.active("home")).toHaveLength(1);
  });

  it("繰り返しの削除は、mode がないと聞き返す。skip_next で次の1回だけ休む", async () => {
    const { repo, call } = toolsSetup();
    await call("reminder_create", { title: "燃えるゴミ", when: { type: "weekly", weekdays: [1], time: "07:30" } });
    const ng = await call("reminder_delete", { title: "燃えるゴミ" });
    expect(ng.value.error).toMatch(/^ask_user/);
    await call("reminder_delete", { title: "燃えるゴミ", mode: "skip_next" });
    expect(repo.active("home")[0]!.skip_next).toBe(1);
  });

  it("候補が複数あると確認を求める", async () => {
    const { call } = toolsSetup();
    await call("reminder_create", { title: "ゴミ出し（燃える）", when: { type: "daily", time: "07:00" } });
    await call("reminder_create", { title: "ゴミ出し（資源）", when: { type: "daily", time: "07:10" } });
    const r = await call("reminder_delete", { title: "ゴミ出し", mode: "all" });
    expect(r.value.error).toMatch(/候補が複数/);
  });
});

/** MQTT でつながった偽の端末と、偽の時計を使うサーバー */
async function schedulerSetup() {
  const clock = new FakeClock(new Date("2026-10-20T10:00:00+09:00"));
  const tts = new FakeTts();
  const t = await startTestApp({
    stt: new FakeStt([said("こんにちは"), "silent"]),
    tts,
    llm: new FakeLlm([{ text: "こんにちは。" }]),
    clock,
    configure: (c) => {
      c.server.deviceTransport = "mqtt";
      c.conversation.followUpSeconds = 0;
    },
  });
  cleanup.push(() => t.app.close());
  t.config.mqtt.publicEndpoint = `127.0.0.1:${t.app.mqtt!.mqttPort()}`;
  const deviceId = "aa:bb:cc:00:00:02";
  const first = await callOta(t.base, deviceId, "c");
  t.app.devices.approveByCode(first.body.activation.code, new Date());
  const ota = await callOta(t.base, deviceId, "c");
  const connect = async () => {
    const dev = new FakeMqttDevice(ota.body.mqtt);
    await dev.connect();
    cleanup.push(() => dev.close());
    await new Promise((r) => setTimeout(r, 50));
    return dev;
  };
  const add = (title: string, at: string) => {
    const next = new Date(`${at}+09:00`);
    return t.app.reminders.create("home", title, { kind: "once", date: at.slice(0, 10), time: at.slice(11, 16) }, next, clock.now());
  };
  const notifies = (dev: FakeMqttDevice) => dev.json.filter((m) => m.type === "notify");
  return { ...t, clock, tts, connect, add, notifies, deviceId };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("スケジューラー", () => {
  it("時刻になると notify を送る。音声の URL は1回だけ取れる", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    s.add("ゴミ出し", "2026-10-20T10:02");
    await s.app.scheduler.tick();
    expect(s.notifies(dev)).toHaveLength(0);
    s.clock.advance(2 * 60_000);
    await s.app.scheduler.tick();
    await settle();
    const n = s.notifies(dev);
    expect(n).toHaveLength(1);
    expect(n[0]!.subtitles[0].text).toBe("ゴミ出しの時間です。");
    expect(s.tts.texts).toContain("ゴミ出しの時間です。");
    const url = new URL(n[0]!.audio_url);
    expect((await fetch(new URL(url.pathname, s.base))).status).toBe(200);
    expect((await fetch(new URL(url.pathname, s.base))).status).toBe(404);
  });

  it("5分以内に反応がなければ1回だけ再送する。2回目のあとは送らない", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    await settle();
    s.clock.advance(5 * 60_000);
    await s.app.scheduler.tick();
    await settle();
    s.clock.advance(10 * 60_000);
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(2);
  });

  it("反応（会話の開始）があれば再送しない", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    await settle();
    await dev.openAudio(); // ボタンや呼びかけで会話を始めた
    dev.goodbye();
    await settle();
    s.clock.advance(6 * 60_000);
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(1);
  });

  it("同じ時刻のものはまとめて1回で読み上げる", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    s.add("ゴミ出し", "2026-10-20T10:00");
    s.add("洗濯物", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(1);
    expect(s.notifies(dev)[0]!.subtitles[0].text).toBe("ゴミ出しと、洗濯物の時間です。");
  });

  it("会話中は待ち、会話が終わってから送る", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    await dev.openAudio(); // 会話中
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(0);
    dev.goodbye();
    await settle();
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(1);
  });

  it("つながっていない間に時刻が過ぎても、2時間以内につながれば「遅れてお知らせします」を付けて送る", async () => {
    const s = await schedulerSetup();
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    s.clock.advance(90 * 60_000);
    const dev = await s.connect(); // つながると tick が走る
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)[0]!.subtitles[0].text).toBe("遅れてお知らせします。ゴミ出しの時間でした。");
  });

  it("2時間より古いものは送らず、次の会話の最初に伝える（伝えたら繰り返さない）", async () => {
    const s = await schedulerSetup();
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    s.clock.advance(3 * 60 * 60_000);
    await s.app.scheduler.tick();
    const notes = s.app.scheduler.pendingNotes();
    expect(notes?.notes[0]).toContain("ゴミ出し（10月20日（火）午前10時）");
    notes!.consume();
    expect(s.app.scheduler.pendingNotes()).toBeUndefined();
    const dev = await s.connect();
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(0);
  });

  it("サーバーを再起動しても（データベースから）通知を失わず、1回だけ送る", async () => {
    const s = await schedulerSetup();
    s.add("ゴミ出し", "2026-10-20T10:01");
    // 再起動を模す：同じデータベースで新しいスケジューラーを2つ作って、両方で tick しても二重にならない
    const { ReminderScheduler } = await import("../src/app/reminder-scheduler.js");
    const { NotifyAudioStore } = await import("../src/app/notify-audio.js");
    const fresh = new RemindersRepo(s.db, TZ);
    const a = new ReminderScheduler(fresh, s.app.hub, s.tts, new NotifyAudioStore(), s.clock, {
      tz: TZ,
      publicBaseUrl: () => s.base,
      retryMinutes: 5,
      maxLateMinutes: 120,
    });
    cleanup.push(() => a.stop());
    const dev = await s.connect();
    s.clock.advance(60_000);
    await Promise.all([a.tick(), s.app.scheduler.tick()]);
    await settle();
    expect(s.notifies(dev)).toHaveLength(1);
  });

  it("繰り返しは次回に進む。「次の1回だけ休む」はその回を飛ばす", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    const r = s.app.reminders.create("home", "燃えるゴミ", { kind: "daily", time: "10:00" }, new Date("2026-10-20T10:00:00+09:00"), s.clock.now());
    s.app.reminders.setSkipNext("home", r.id, true, s.clock.now());
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(0);
    expect(s.app.reminders.get("home", r.id)!.next_fire_at).toBe(new Date("2026-10-21T10:00:00+09:00").toISOString());
    s.clock.advance(24 * 60 * 60_000);
    await s.app.scheduler.tick();
    await settle();
    expect(s.notifies(dev)).toHaveLength(1);
  });

  it("音声が作れないときは alert（画面と通知音）で知らせる", async () => {
    const s = await schedulerSetup();
    const dev = await s.connect();
    s.tts.failWith = new Error("tts down");
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    await settle();
    expect(dev.json.find((m) => m.type === "alert")?.message).toBe("ゴミ出しの時間です。");
  });
});

describe("会話の最初に未通知を伝える", () => {
  it("missed があると、最初の発話の LLM への入力に補足が付く", async () => {
    const s = await schedulerSetup();
    s.add("ゴミ出し", "2026-10-20T10:00");
    await s.app.scheduler.tick();
    s.clock.advance(3 * 60 * 60_000);
    await s.app.scheduler.tick();
    const dev = await s.connect();
    await dev.openAudio();
    dev.startListening();
    const enc = new OpusEncoder(16000);
    dev.sendAudio(enc.encodeAll(new Int16Array(960))[0]!);
    enc.close();
    await dev.waitFor((m) => m.type === "tts" && m.state === "stop");
    expect(s.app.scheduler.pendingNotes()).toBeUndefined();
  });
});
