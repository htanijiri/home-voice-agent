// 日ごと（日本時間）の利用量
import { localDateString } from "../core/time.js";
import type { Db } from "./db.js";

export type UsageKind =
  | "turns"
  | "stt_seconds"
  | "tts_chars"
  | "llm_input_tokens"
  | "llm_output_tokens"
  | "llm_cache_read_tokens"
  | "llm_cache_write_tokens";

export class UsageRepo {
  constructor(
    private readonly db: Db,
    private readonly timeZone: string,
  ) {}

  add(now: Date, kind: UsageKind, quantity: number): void {
    if (!quantity) return;
    this.db
      .prepare(
        "INSERT INTO usage (day, kind, quantity) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET quantity = quantity + excluded.quantity",
      )
      .run(localDateString(now, this.timeZone), kind, quantity);
  }

  get(day: string, kind: UsageKind): number {
    const row = this.db.prepare("SELECT quantity FROM usage WHERE day = ? AND kind = ?").get(day, kind) as
      | { quantity: number }
      | undefined;
    return row?.quantity ?? 0;
  }

  today(now: Date, kind: UsageKind): number {
    return this.get(localDateString(now, this.timeZone), kind);
  }

  /** 期間（YYYY-MM-DD の前方一致。例：2026-11）の合計 */
  sumByPrefix(prefix: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT kind, SUM(quantity) AS q FROM usage WHERE day LIKE ? GROUP BY kind")
      .all(`${prefix}%`) as { kind: string; q: number }[];
    return Object.fromEntries(rows.map((r) => [r.kind, r.q]));
  }
}
