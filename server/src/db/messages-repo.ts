// 家族への連絡（016）。リビングからの声の連絡（voice）と、確認画面からの読み上げ（announce）を1本に並べる。
// 文章はログに出さない。30 日で消す（会話の記録と同じ）。
import { localDateString } from "../core/time.js";
import type { Db } from "./db.js";

export type MessageKind = "voice" | "announce";
/** 確認画面からの読み上げの結果。dropped は、会話が終わらず読み上げられなかったもの */
export type AnnounceResult = "sent" | "queued" | "offline" | "busy" | "dropped";

export interface FamilyMessage {
  id: number;
  household_id: string;
  kind: MessageKind;
  to_label: string | null;
  text: string;
  sender_email: string | null;
  sender_name: string | null;
  status: AnnounceResult | null;
  created_at: string;
}

export class MessagesRepo {
  constructor(
    private readonly db: Db,
    private readonly tz: string,
    private readonly onChange: (householdId: string) => void = () => undefined,
  ) {}

  addVoice(householdId: string, to: string | undefined, text: string, now: Date): FamilyMessage {
    return this.insert(householdId, "voice", to?.trim() || null, text, null, null, null, now);
  }

  addAnnounce(householdId: string, text: string, sender: { email: string; name?: string }, status: AnnounceResult, now: Date): FamilyMessage {
    return this.insert(householdId, "announce", null, text, sender.email, sender.name ?? null, status, now);
  }

  setStatus(id: number, status: AnnounceResult): void {
    const row = this.db.prepare("UPDATE family_messages SET status = ? WHERE id = ? RETURNING household_id").get(status, id) as
      | { household_id: string }
      | undefined;
    if (row) this.onChange(row.household_id);
  }

  /** 新しい順 */
  list(householdId: string, limit = 100): FamilyMessage[] {
    return this.db
      .prepare("SELECT * FROM family_messages WHERE household_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(householdId, limit) as FamilyMessage[];
  }

  /** その日（家庭の時刻）に、リビングから送った数 */
  voiceCountOn(householdId: string, now: Date): number {
    const today = localDateString(now, this.tz);
    // 前後 1 日を SQL で絞り、日付は家庭の時刻で数える
    const since = new Date(now.getTime() - 86_400_000 * 2).toISOString();
    const rows = this.db
      .prepare("SELECT created_at FROM family_messages WHERE household_id = ? AND kind = 'voice' AND created_at >= ?")
      .all(householdId, since) as { created_at: string }[];
    return rows.filter((r) => localDateString(new Date(r.created_at), this.tz) === today).length;
  }

  deleteOlderThan(cutoff: Date): number {
    return this.db.prepare("DELETE FROM family_messages WHERE created_at < ?").run(cutoff.toISOString()).changes;
  }

  private insert(
    householdId: string,
    kind: MessageKind,
    to: string | null,
    text: string,
    email: string | null,
    name: string | null,
    status: AnnounceResult | null,
    now: Date,
  ): FamilyMessage {
    const r = this.db
      .prepare(
        "INSERT INTO family_messages (household_id, kind, to_label, text, sender_email, sender_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(householdId, kind, to, text, email, name, status, now.toISOString());
    this.onChange(householdId);
    return this.db.prepare("SELECT * FROM family_messages WHERE id = ?").get(Number(r.lastInsertRowid)) as FamilyMessage;
  }
}
