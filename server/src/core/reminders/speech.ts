// 日時と予定を、読み上げやすい日本語にする
import type { Schedule } from "./schedule.js";
import { parseTime, toLocal } from "./zoned.js";

const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function spokenTime(hh: number, mm: number): string {
  const ampm = hh < 12 ? "午前" : "午後";
  const h = hh % 12 === 0 ? (hh === 0 ? 0 : 12) : hh % 12;
  return `${ampm}${h}時${mm ? `${mm}分` : ""}`;
}

export function spokenDateTime(d: Date, tz: string): string {
  const l = toLocal(d, tz);
  return `${l.m}月${l.d}日（${WD[l.wd]}）${spokenTime(l.hh, l.mm)}`;
}

export function spokenSchedule(s: Schedule, tz: string, next?: Date): string {
  const { hh, mm } = parseTime(s.time);
  const t = spokenTime(hh, mm);
  switch (s.kind) {
    case "once":
      return next ? spokenDateTime(next, tz) : `${s.date} ${t}`;
    case "daily":
      return `毎日${t}`;
    case "weekdays":
      return `平日の${t}`;
    case "weekly":
      return `毎週${[...s.weekdays].sort().map((w) => `${WD[w]}曜日`).join("と")}の${t}`;
    case "monthly_day":
      return `毎月${s.day}日の${t}`;
    case "monthly_nth":
      return `毎月${[...s.nths].sort((a, b) => (a === -1 ? 1 : b === -1 ? -1 : a - b)).map((n) => (n === -1 ? "最終" : `第${n}`)).join("・")}${WD[s.weekday]}曜日の${t}`;
  }
}
