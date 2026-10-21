// 日本時間（設定のタイムゾーン）での日付・時刻の計算
export function localDateString(d: Date, timeZone = "Asia/Tokyo"): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function localTimeHHMM(d: Date, timeZone = "Asia/Tokyo"): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/** 「2026年10月20日（火）17時05分」のような表記 */
export function formatJapaneseDateTime(d: Date, timeZone = "Asia/Tokyo"): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}年${get("month")}${get("day")}日（${get("weekday")}）${get("hour")}時${get("minute")}分`;
}

/** HH:MM が [start, end) の範囲か。日をまたぐ範囲（22:00〜07:00）に対応する */
export function isWithin(hhmm: string, start: string, end: string): boolean {
  if (start <= end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}
