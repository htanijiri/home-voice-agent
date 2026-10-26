import { UserError } from "../core/errors.js";
// リマインダーと通知の記録
import { nextOccurrence, type Schedule } from "../core/reminders/schedule.js";
import type { Db } from "./db.js";

export interface ReminderRow {
  id: number;
  household_id: string;
  title: string;
  schedule: string;
  next_fire_at: string | null;
  status: "active" | "done" | "deleted";
  skip_next: number;
  created_at: string;
  updated_at: string;
}
export interface Reminder extends Omit<ReminderRow, "schedule"> {
  schedule: Schedule;
}

export type DeliveryState = "pending" | "sent" | "acknowledged" | "done" | "missed" | "told" | "skipped";
export interface DeliveryRow {
  id: number;
  reminder_id: number;
  title: string;
  scheduled_at: string;
  state: DeliveryState;
  attempts: number;
  sent_at: string | null;
  ack_at: string | null;
  /** もう1回読み上げる時刻（2回目のあとは、終わりにする時刻）（015） */
  retry_at: string | null;
}

const toReminder = (r: ReminderRow): Reminder => ({ ...r, schedule: JSON.parse(r.schedule) as Schedule });

export class RemindersRepo {
  /** onChange：一覧の表示が変わったときに呼ぶ（確認画面への通知） */
  constructor(
    private readonly db: Db,
    private readonly tz: string,
    private readonly onChange: (householdId: string) => void = () => undefined,
  ) {}

  create(householdId: string, title: string, schedule: Schedule, next: Date, now: Date): Reminder {
    const ts = now.toISOString();
    const r = this.db
      .prepare(
        "INSERT INTO reminders (household_id, title, schedule, next_fire_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      )
      .run(householdId, title.trim(), JSON.stringify(schedule), next.toISOString(), ts, ts);
    this.onChange(householdId);
    return this.get(householdId, Number(r.lastInsertRowid))!;
  }

  get(householdId: string, id: number): Reminder | undefined {
    const r = this.db.prepare("SELECT * FROM reminders WHERE household_id = ? AND id = ?").get(householdId, id) as
      | ReminderRow
      | undefined;
    return r ? toReminder(r) : undefined;
  }

  active(householdId: string): Reminder[] {
    return (
      this.db
        .prepare("SELECT * FROM reminders WHERE household_id = ? AND status = 'active' ORDER BY next_fire_at, id")
        .all(householdId) as ReminderRow[]
    ).map(toReminder);
  }

  update(householdId: string, id: number, fields: { title?: string; schedule?: Schedule; next?: Date }, now: Date): Reminder {
    const r = this.get(householdId, id);
    if (!r || r.status !== "active") throw new UserError("そのリマインダーはありません");
    this.db
      .prepare("UPDATE reminders SET title = ?, schedule = ?, next_fire_at = ?, skip_next = 0, updated_at = ? WHERE id = ?")
      .run(
        fields.title?.trim() || r.title,
        JSON.stringify(fields.schedule ?? r.schedule),
        (fields.next ?? (r.next_fire_at ? new Date(r.next_fire_at) : now)).toISOString(),
        now.toISOString(),
        id,
      );
    this.onChange(householdId);
    return this.get(householdId, id)!;
  }

  delete(householdId: string, id: number, now: Date): void {
    this.db
      .prepare("UPDATE reminders SET status = 'deleted', updated_at = ? WHERE household_id = ? AND id = ?")
      .run(now.toISOString(), householdId, id);
    // まだ読み上げていない分も取り消す
    this.db.prepare("UPDATE reminder_deliveries SET state = 'skipped' WHERE reminder_id = ? AND state = 'pending'").run(id);
    this.onChange(householdId);
  }

  setSkipNext(householdId: string, id: number, skip: boolean, now: Date): void {
    this.db
      .prepare("UPDATE reminders SET skip_next = ?, updated_at = ? WHERE household_id = ? AND id = ?")
      .run(skip ? 1 : 0, now.toISOString(), householdId, id);
    this.onChange(householdId);
  }

  /** 時刻が来たリマインダー */
  due(now: Date): Reminder[] {
    return (
      this.db
        .prepare("SELECT * FROM reminders WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at")
        .all(now.toISOString()) as ReminderRow[]
    ).map(toReminder);
  }

  /**
   * 時刻が来た1回分を通知の記録にし、リマインダーを次回へ進める（1つのトランザクションで行い、二重に作らない）。
   * 「次の1回だけ休む」が付いていれば、記録は skipped にする。
   */
  takeDue(r: Reminder): DeliveryRow | undefined {
    const row = this.db.transaction((): DeliveryRow | undefined => {
      const scheduledAt = r.next_fire_at!;
      const state: DeliveryState = r.skip_next ? "skipped" : "pending";
      this.db
        .prepare("INSERT OR IGNORE INTO reminder_deliveries (reminder_id, title, scheduled_at, state) VALUES (?, ?, ?, ?)")
        .run(r.id, r.title, scheduledAt, state);
      const next = r.schedule.kind === "once" ? undefined : nextOccurrence(r.schedule, new Date(scheduledAt), this.tz);
      this.db
        .prepare("UPDATE reminders SET next_fire_at = ?, status = ?, skip_next = 0 WHERE id = ?")
        .run(next?.toISOString() ?? null, next ? "active" : "done", r.id);
      return this.db
        .prepare("SELECT * FROM reminder_deliveries WHERE reminder_id = ? AND scheduled_at = ?")
        .get(r.id, scheduledAt) as DeliveryRow;
    })();
    this.onChange(r.household_id);
    return row;
  }

  deliveries(states: DeliveryState[]): DeliveryRow[] {
    return this.db
      .prepare(`SELECT * FROM reminder_deliveries WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY scheduled_at, id`)
      .all(...states) as DeliveryRow[];
  }

  markSent(ids: number[], now: Date, retryAt: Date): void {
    const st = this.db.prepare(
      "UPDATE reminder_deliveries SET state = 'sent', attempts = attempts + 1, sent_at = ?, retry_at = ? WHERE id = ?",
    );
    this.db.transaction(() => ids.forEach((id) => st.run(now.toISOString(), retryAt.toISOString(), id)))();
  }

  setState(ids: number[], state: DeliveryState, now?: Date): void {
    const st = this.db.prepare(
      `UPDATE reminder_deliveries SET state = ?${state === "acknowledged" ? ", ack_at = ?" : ""} WHERE id = ?`,
    );
    this.db.transaction(() =>
      ids.forEach((id) => (state === "acknowledged" ? st.run(state, now!.toISOString(), id) : st.run(state, id))),
    )();
  }
}
