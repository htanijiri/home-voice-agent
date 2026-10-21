// LLM が出した「いつ」（構造化した値）を、日本時間で解釈して予定にする。
// 相対表現（明日・来週の金曜・3時間後）の計算はここで行い、LLM には任せない。
// はっきりしないときは AskUser を投げ、LLM にユーザーへ聞き返させる。
import { nextOccurrence, type Schedule, validateSchedule } from "./schedule.js";
import { addDays, dateKey, fromLocal, isValidDate, type LocalDate, parseTime, timeKey, toLocal, weekdayOf } from "./zoned.js";

/** ユーザーに聞き返す必要がある（メッセージは LLM 向け） */
export class AskUser extends Error {}

export interface WhenInput {
  type: "once" | "in_duration" | "daily" | "weekdays" | "weekly" | "monthly_day" | "monthly_nth";
  /** 一回限りの日付（どれか1つ）。省略すると「今日、過ぎていれば明日」 */
  date?: {
    relative?: "today" | "tomorrow" | "day_after_tomorrow";
    in_days?: number;
    weekday?: number;
    /** weekday と組み合わせる。upcoming＝次に来るその曜日、this＝今週、next＝来週 */
    week?: "upcoming" | "this" | "next";
    month?: number;
    day?: number;
    year?: number;
  };
  /** 24 時間制の HH:MM */
  time?: string;
  /** 「8時」のように午前・午後を言っていないとき true */
  ampm_unspecified?: boolean;
  /** in_duration：何分後か */
  minutes?: number;
  weekdays?: number[];
  day?: number;
  nths?: number[];
  weekday?: number;
}

function resolveDate(d: WhenInput["date"], today: LocalDate): LocalDate | undefined {
  if (!d) return undefined;
  if (d.relative === "today") return today;
  if (d.relative === "tomorrow") return addDays(today, 1);
  if (d.relative === "day_after_tomorrow") return addDays(today, 2);
  if (typeof d.in_days === "number") {
    if (d.in_days < 0 || d.in_days > 366) throw new AskUser("日付が範囲外です");
    return addDays(today, d.in_days);
  }
  if (typeof d.weekday === "number") {
    const wd = weekdayOf(today);
    // 週は月曜はじまり
    const mondayOffset = (wd + 6) % 7;
    const target = (d.weekday + 6) % 7;
    if (d.week === "this") return addDays(today, target - mondayOffset);
    if (d.week === "next") return addDays(today, 7 - mondayOffset + target);
    return addDays(today, (d.weekday - wd + 7) % 7); // upcoming（今日を含む）
  }
  if (typeof d.month === "number" && typeof d.day === "number") {
    const ld = { y: d.year ?? today.y, m: d.month, d: d.day };
    if (!isValidDate(ld)) throw new AskUser(`${d.month}月${d.day}日という日はありません。日付を確認してください`);
    // 年の指定がなく、今年の日付が過ぎていれば来年にする
    if (!d.year && dateKey(ld) < dateKey(today)) return { ...ld, y: ld.y + 1 };
    return ld;
  }
  return undefined;
}

/** 午前・午後が曖昧な時刻の候補 */
function timeCandidates(time: string, ampmUnspecified: boolean | undefined): { hh: number; mm: number }[] {
  const t = parseTime(time);
  if (!ampmUnspecified || t.hh > 12 || t.hh === 0) return [t];
  if (t.hh === 12) return [t, { hh: 0, mm: t.mm }];
  return [t.hh < 12 ? t : { hh: t.hh - 12, mm: t.mm }, { hh: (t.hh % 12) + 12, mm: t.mm }];
}

export function resolveWhen(w: WhenInput, now: Date, tz: string): { schedule: Schedule; next: Date } {
  const l = toLocal(now, tz);
  const today: LocalDate = { y: l.y, m: l.m, d: l.d };

  if (w.type === "in_duration") {
    if (!w.minutes || w.minutes < 1 || w.minutes > 7 * 24 * 60) throw new AskUser("何分後か（1分〜7日）を確認してください");
    const at = new Date(Math.ceil((now.getTime() + w.minutes * 60_000) / 60_000) * 60_000);
    const la = toLocal(at, tz);
    const schedule: Schedule = { kind: "once", date: dateKey(la), time: timeKey(la.hh, la.mm) };
    return { schedule, next: at };
  }

  if (!w.time) throw new AskUser("何時にお知らせするか、ユーザーに確認してください");
  const cands = timeCandidates(w.time, w.ampm_unspecified);

  if (w.type === "once") {
    const date = resolveDate(w.date, today);
    const days = date ? [date] : [today, addDays(today, 1)]; // 日付なし：今日、過ぎていれば明日
    for (const day of days) {
      const future = cands.map((c) => ({ c, at: fromLocal(day, c.hh, c.mm, tz) })).filter((x) => x.at > now);
      if (future.length > 1) {
        const h = future[0]!.c.hh % 12 || 12;
        throw new AskUser(`午前${h}時か午後${h}時か、ユーザーに確認してください`);
      }
      if (future.length === 1) {
        const { c, at } = future[0]!;
        return { schedule: { kind: "once", date: dateKey(day), time: timeKey(c.hh, c.mm) }, next: at };
      }
    }
    throw new AskUser("その日時はもう過ぎています。日時をユーザーに確認してください");
  }

  // 繰り返し：午前・午後が曖昧なら必ず聞き返す
  if (cands.length > 1) {
    const h = cands[0]!.hh % 12 || 12;
    throw new AskUser(`午前${h}時か午後${h}時か、ユーザーに確認してください`);
  }
  const time = timeKey(cands[0]!.hh, cands[0]!.mm);
  let schedule: Schedule;
  switch (w.type) {
    case "daily":
      schedule = { kind: "daily", time };
      break;
    case "weekdays":
      schedule = { kind: "weekdays", time };
      break;
    case "weekly":
      schedule = { kind: "weekly", weekdays: [...new Set(w.weekdays ?? [])].sort(), time };
      break;
    case "monthly_day":
      schedule = { kind: "monthly_day", day: w.day ?? 0, time };
      break;
    case "monthly_nth":
      schedule = { kind: "monthly_nth", nths: [...new Set(w.nths ?? [])], weekday: w.weekday ?? -1, time };
      break;
    default:
      throw new AskUser("繰り返しの種類が分かりません");
  }
  try {
    validateSchedule(schedule);
  } catch (err) {
    throw new AskUser(`繰り返しの指定を確認してください（${(err as Error).message}）`);
  }
  const next = nextOccurrence(schedule, now, tz);
  if (!next) throw new AskUser("次にお知らせする日が見つかりません");
  return { schedule, next };
}
