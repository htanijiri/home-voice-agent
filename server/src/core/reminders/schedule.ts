// リマインダーの予定（一回限り・繰り返し）と、次の通知時刻の計算
import {
  addDays,
  daysInMonth,
  fromLocal,
  type LocalDate,
  parseDateKey,
  parseTime,
  toLocal,
  weekdayOf,
} from "./zoned.js";

export type Schedule =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekdays: number[]; time: string }
  /** 毎月◯日。その月にない日（31日など）は、その月の最終日にする */
  | { kind: "monthly_day"; day: number; time: string }
  /** 毎月第◯◯曜日。nths は 1〜5、-1 は最終 */
  | { kind: "monthly_nth"; nths: number[]; weekday: number; time: string };

export function isRecurring(s: Schedule): boolean {
  return s.kind !== "once";
}

function matches(s: Schedule, ld: LocalDate): boolean {
  const wd = weekdayOf(ld);
  switch (s.kind) {
    case "once":
      return s.date === `${ld.y}-${String(ld.m).padStart(2, "0")}-${String(ld.d).padStart(2, "0")}`;
    case "daily":
      return true;
    case "weekdays":
      return wd >= 1 && wd <= 5;
    case "weekly":
      return s.weekdays.includes(wd);
    case "monthly_day":
      return ld.d === Math.min(s.day, daysInMonth(ld.y, ld.m));
    case "monthly_nth": {
      if (wd !== s.weekday) return false;
      const nth = Math.floor((ld.d - 1) / 7) + 1;
      const isLast = ld.d + 7 > daysInMonth(ld.y, ld.m);
      return s.nths.includes(nth) || (isLast && s.nths.includes(-1));
    }
  }
}

/** after より後（同時刻は含まない）の、最初の通知時刻 */
export function nextOccurrence(s: Schedule, after: Date, tz: string): Date | undefined {
  const { hh, mm } = parseTime(s.time);
  if (s.kind === "once") {
    const t = fromLocal(parseDateKey(s.date), hh, mm, tz);
    return t > after ? t : undefined;
  }
  const start = toLocal(after, tz);
  let day: LocalDate = { y: start.y, m: start.m, d: start.d };
  for (let i = 0; i < 400; i++) {
    if (matches(s, day)) {
      const t = fromLocal(day, hh, mm, tz);
      if (t > after) return t;
    }
    day = addDays(day, 1);
  }
  return undefined;
}

export function validateSchedule(s: Schedule): void {
  parseTime(s.time);
  const wdOk = (n: number) => Number.isInteger(n) && n >= 0 && n <= 6;
  switch (s.kind) {
    case "once":
      parseDateKey(s.date);
      return;
    case "weekly":
      if (!s.weekdays.length || !s.weekdays.every(wdOk)) throw new Error("weekdays は 0（日）〜6（土）");
      return;
    case "monthly_day":
      if (!Number.isInteger(s.day) || s.day < 1 || s.day > 31) throw new Error("day は 1〜31");
      return;
    case "monthly_nth":
      if (!wdOk(s.weekday)) throw new Error("weekday は 0（日）〜6（土）");
      if (!s.nths.length || !s.nths.every((n) => n === -1 || (Number.isInteger(n) && n >= 1 && n <= 5))) {
        throw new Error("nths は 1〜5 か -1（最終）");
      }
      return;
    default:
      return;
  }
}
