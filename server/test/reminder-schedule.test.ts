import { describe, expect, it } from "vitest";
import { AskUser, resolveWhen } from "../src/core/reminders/resolve.js";
import { nextOccurrence, type Schedule } from "../src/core/reminders/schedule.js";
import { spokenDateTime, spokenSchedule } from "../src/core/reminders/speech.js";

const TZ = "Asia/Tokyo";
const at = (s: string) => new Date(`${s}+09:00`);
const NOW = at("2026-10-20T10:00:00"); // 火曜
const iso = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16);

describe("一回限りの解釈", () => {
  it("明日の午前8時", () => {
    const r = resolveWhen({ type: "once", date: { relative: "tomorrow" }, time: "08:00" }, NOW, TZ);
    expect(iso(r.next)).toBe("2026-10-21T08:00");
    expect(r.schedule).toEqual({ kind: "once", date: "2026-10-21", time: "08:00" });
    expect(spokenDateTime(r.next, TZ)).toBe("10月21日（水）午前8時");
  });
  it("来週の金曜 15:30（来週＝月曜はじまりの次の週）", () => {
    const r = resolveWhen({ type: "once", date: { weekday: 5, week: "next" }, time: "15:30" }, NOW, TZ);
    expect(iso(r.next)).toBe("2026-10-30T15:30");
  });
  it("今週の金曜", () => {
    expect(iso(resolveWhen({ type: "once", date: { weekday: 5, week: "this" }, time: "09:00" }, NOW, TZ).next)).toBe("2026-10-23T09:00");
  });
  it("（次に来る）火曜：今日の時刻が過ぎていなければ今日", () => {
    expect(iso(resolveWhen({ type: "once", date: { weekday: 2 }, time: "18:00" }, NOW, TZ).next)).toBe("2026-10-20T18:00");
  });
  it("3時間後", () => {
    expect(iso(resolveWhen({ type: "in_duration", minutes: 180 }, NOW, TZ).next)).toBe("2026-10-20T13:00");
  });
  it("月末をまたぐ：明後日（10/31 → 11/2）", () => {
    const r = resolveWhen({ type: "once", date: { relative: "day_after_tomorrow" }, time: "07:00" }, at("2026-10-31T12:00:00"), TZ);
    expect(iso(r.next)).toBe("2026-11-02T07:00");
  });
  it("年をまたぐ：日付だけで今年の分が過ぎていれば来年", () => {
    expect(iso(resolveWhen({ type: "once", date: { month: 1, day: 5 }, time: "09:00" }, NOW, TZ).next)).toBe("2027-01-05T09:00");
  });
  it("うるう年の2月29日（2028年はある、2027年はない）", () => {
    expect(iso(resolveWhen({ type: "once", date: { year: 2028, month: 2, day: 29 }, time: "09:00" }, NOW, TZ).next)).toBe("2028-02-29T09:00");
    expect(() => resolveWhen({ type: "once", date: { year: 2027, month: 2, day: 29 }, time: "09:00" }, NOW, TZ)).toThrow(AskUser);
  });
  it("日付なしの時刻：今日の時刻が過ぎていれば明日", () => {
    expect(iso(resolveWhen({ type: "once", time: "09:00" }, NOW, TZ).next)).toBe("2026-10-21T09:00");
    expect(iso(resolveWhen({ type: "once", time: "11:00" }, NOW, TZ).next)).toBe("2026-10-20T11:00");
  });
});

describe("はっきりしないときは聞き返す", () => {
  it("時刻がない", () => {
    expect(() => resolveWhen({ type: "once", date: { weekday: 5 } }, NOW, TZ)).toThrow(/何時/);
  });
  it("午前・午後が曖昧で、どちらもこれから先", () => {
    expect(() =>
      resolveWhen({ type: "once", date: { relative: "tomorrow" }, time: "08:00", ampm_unspecified: true }, NOW, TZ),
    ).toThrow(/午前8時か午後8時/);
  });
  it("午前・午後が曖昧でも、片方しか先にないならそちら（今日の8時→20時）", () => {
    const r = resolveWhen({ type: "once", date: { relative: "today" }, time: "08:00", ampm_unspecified: true }, NOW, TZ);
    expect(iso(r.next)).toBe("2026-10-20T20:00");
  });
  it("過去の日時", () => {
    expect(() => resolveWhen({ type: "once", date: { relative: "today" }, time: "09:00" }, NOW, TZ)).toThrow(/過ぎています/);
  });
  it("繰り返しで午前・午後が曖昧なら必ず聞き返す", () => {
    expect(() => resolveWhen({ type: "daily", time: "07:00", ampm_unspecified: true }, NOW, TZ)).toThrow(AskUser);
  });
});

describe("繰り返しの次回", () => {
  const next = (s: Schedule, from = NOW) => iso(nextOccurrence(s, from, TZ)!);
  it("毎日", () => {
    expect(next({ kind: "daily", time: "09:00" })).toBe("2026-10-21T09:00");
    expect(next({ kind: "daily", time: "11:00" })).toBe("2026-10-20T11:00");
  });
  it("平日（金曜の次は月曜）", () => {
    expect(next({ kind: "weekdays", time: "07:00" }, at("2026-10-23T08:00:00"))).toBe("2026-10-26T07:00");
  });
  it("毎週月曜と木曜", () => {
    const s: Schedule = { kind: "weekly", weekdays: [1, 4], time: "07:30" };
    expect(next(s)).toBe("2026-10-22T07:30");
    expect(next(s, at("2026-10-22T07:30:00"))).toBe("2026-10-26T07:30"); // 同時刻は含まない
  });
  it("毎月31日：31日がない月は最終日", () => {
    const s: Schedule = { kind: "monthly_day", day: 31, time: "09:00" };
    expect(next(s, at("2026-11-01T00:00:00"))).toBe("2026-11-30T09:00");
    expect(next(s, at("2027-02-01T00:00:00"))).toBe("2027-02-28T09:00");
  });
  it("毎月第2・第4水曜（ゴミの日）", () => {
    const s: Schedule = { kind: "monthly_nth", nths: [2, 4], weekday: 3, time: "08:00" };
    expect(next(s)).toBe("2026-10-28T08:00"); // 10月の水曜：7,14,21,28 → 第4は28日
    expect(next(s, at("2026-10-28T09:00:00"))).toBe("2026-11-11T08:00"); // 11月：4,11,18,25
  });
  it("毎月最終金曜", () => {
    expect(next({ kind: "monthly_nth", nths: [-1], weekday: 5, time: "18:00" })).toBe("2026-10-30T18:00");
  });
  it("読み上げ用の表記", () => {
    expect(spokenSchedule({ kind: "weekly", weekdays: [4, 1], time: "07:30" }, TZ)).toBe("毎週月曜日と木曜日の午前7時30分");
    expect(spokenSchedule({ kind: "monthly_nth", nths: [4, 2], weekday: 3, time: "20:00" }, TZ)).toBe("毎月第2・第4水曜日の午後8時");
  });
});
