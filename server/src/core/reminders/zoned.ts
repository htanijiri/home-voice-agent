// タイムゾーン付きの日付の計算（日本時間を前提にしつつ、Intl で一般的に計算する）
export interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
}
export interface LocalDateTime extends LocalDate {
  hh: number;
  mm: number;
  /** 0=日曜 … 6=土曜 */
  wd: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toLocal(date: Date, tz: string): LocalDateTime {
  const p = Object.fromEntries(fmt(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour!, mm: +p.minute!, wd: WD[p.weekday!]! };
}

/** 現地の日時を UTC の Date にする */
export function fromLocal(ld: LocalDate, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(ld.y, ld.m - 1, ld.d, hh, mm);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const l = toLocal(new Date(t), tz);
    const diff = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm) - guess;
    if (diff === 0) break;
    t -= diff;
  }
  return new Date(t);
}

export function addDays(ld: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(ld.y, ld.m - 1, ld.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function weekdayOf(ld: LocalDate): number {
  return new Date(Date.UTC(ld.y, ld.m - 1, ld.d)).getUTCDay();
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isValidDate(ld: LocalDate): boolean {
  return ld.m >= 1 && ld.m <= 12 && ld.d >= 1 && ld.d <= daysInMonth(ld.y, ld.m);
}

export function dateKey(ld: LocalDate): string {
  return `${ld.y}-${String(ld.m).padStart(2, "0")}-${String(ld.d).padStart(2, "0")}`;
}

export function parseDateKey(s: string): LocalDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date: ${s}`);
  return { y: +m[1]!, m: +m[2]!, d: +m[3]! };
}

export function parseTime(s: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid time: ${s}`);
  const hh = +m[1]!;
  const mm = +m[2]!;
  if (hh > 23 || mm > 59) throw new Error(`invalid time: ${s}`);
  return { hh, mm };
}

export const timeKey = (hh: number, mm: number) => `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
