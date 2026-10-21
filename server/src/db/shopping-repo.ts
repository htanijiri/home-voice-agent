import { UserError } from "../core/errors.js";
// 買い物リスト。音声のツールと確認画面（Web）の両方がこのリポジトリを通る。
import type { Db } from "./db.js";

export interface ShoppingItem {
  id: number;
  household_id: string;
  name: string;
  normalized_name: string;
  note: string | null;
  status: "active" | "bought" | "deleted";
  created_at: string;
  updated_at: string;
  bought_at: string | null;
}

/** 重複を見分けるための正規化：全角半角・大文字小文字・カタカナとひらがな・空白の違いをなくす */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・、。,.]/g, "");
}

/** 「最近買ったもの」を残す日数 */
export const BOUGHT_KEEP_DAYS = 7;

export class ShoppingRepo {
  /** onChange：内容が変わったときに呼ぶ（確認画面への通知） */
  constructor(
    private readonly db: Db,
    private readonly onChange: (householdId: string) => void = () => undefined,
  ) {}

  active(householdId: string): ShoppingItem[] {
    return this.db
      .prepare("SELECT * FROM shopping_items WHERE household_id = ? AND status = 'active' ORDER BY id")
      .all(householdId) as ShoppingItem[];
  }

  recentlyBought(householdId: string, now: Date): ShoppingItem[] {
    const since = new Date(now.getTime() - BOUGHT_KEEP_DAYS * 86_400_000).toISOString();
    return this.db
      .prepare(
        "SELECT * FROM shopping_items WHERE household_id = ? AND status = 'bought' AND bought_at >= ? ORDER BY bought_at DESC",
      )
      .all(householdId, since) as ShoppingItem[];
  }

  get(householdId: string, id: number): ShoppingItem | undefined {
    return this.db.prepare("SELECT * FROM shopping_items WHERE household_id = ? AND id = ?").get(householdId, id) as
      | ShoppingItem
      | undefined;
  }

  findActiveByName(householdId: string, name: string): ShoppingItem | undefined {
    return this.db
      .prepare("SELECT * FROM shopping_items WHERE household_id = ? AND status = 'active' AND normalized_name = ?")
      .get(householdId, normalizeName(name)) as ShoppingItem | undefined;
  }

  /** 追加する。同じ品名（正規化して一致）が既にあれば追加せず、既存のものを返す */
  add(householdId: string, name: string, note: string | undefined, now: Date): { item: ShoppingItem; existed: boolean } {
    const trimmed = name.trim();
    if (!trimmed) throw new UserError("品名が空です");
    if (trimmed.length > 60) throw new UserError("品名が長すぎます");
    const existing = this.findActiveByName(householdId, trimmed);
    if (existing) return { item: existing, existed: true };
    const ts = now.toISOString();
    const r = this.db
      .prepare(
        "INSERT INTO shopping_items (household_id, name, normalized_name, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      )
      .run(householdId, trimmed, normalizeName(trimmed), note?.trim() || null, ts, ts);
    this.onChange(householdId);
    return { item: this.get(householdId, Number(r.lastInsertRowid))!, existed: false };
  }

  update(householdId: string, id: number, fields: { name?: string; note?: string | null }, now: Date): ShoppingItem {
    const item = this.get(householdId, id);
    if (!item) throw new UserError("その品目はありません");
    const name = fields.name?.trim() || item.name;
    const note = fields.note === undefined ? item.note : fields.note?.trim() || null;
    this.db
      .prepare("UPDATE shopping_items SET name = ?, normalized_name = ?, note = ?, updated_at = ? WHERE id = ?")
      .run(name, normalizeName(name), note, now.toISOString(), id);
    this.onChange(householdId);
    return this.get(householdId, id)!;
  }

  setStatus(householdId: string, id: number, status: ShoppingItem["status"], now: Date): ShoppingItem {
    const item = this.get(householdId, id);
    if (!item) throw new UserError("その品目はありません");
    const ts = now.toISOString();
    this.db
      .prepare("UPDATE shopping_items SET status = ?, updated_at = ?, bought_at = ? WHERE id = ?")
      .run(status, ts, status === "bought" ? ts : null, id);
    this.onChange(householdId);
    return this.get(householdId, id)!;
  }

  /** 「最近買ったもの」をリストに戻す。同じ品名が既にリストにあれば戻さない */
  restore(householdId: string, id: number, now: Date): ShoppingItem {
    const item = this.get(householdId, id);
    if (!item) throw new UserError("その品目はありません");
    const dup = this.findActiveByName(householdId, item.name);
    if (dup) return dup;
    return this.setStatus(householdId, id, "active", now);
  }

  clearActive(householdId: string, now: Date): number {
    const changes = this.db
      .prepare("UPDATE shopping_items SET status = 'deleted', updated_at = ? WHERE household_id = ? AND status = 'active'")
      .run(now.toISOString(), householdId).changes;
    if (changes > 0) this.onChange(householdId);
    return changes;
  }

  /** 期限を過ぎた「最近買ったもの」と、削除済みのものを消す */
  purge(now: Date): number {
    const cutoff = new Date(now.getTime() - BOUGHT_KEEP_DAYS * 86_400_000).toISOString();
    return this.db
      .prepare("DELETE FROM shopping_items WHERE (status = 'bought' AND bought_at < ?) OR (status = 'deleted' AND updated_at < ?)")
      .run(cutoff, cutoff).changes;
  }
}
