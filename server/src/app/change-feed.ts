// 買い物リスト・リマインダーの変更の通知。確認画面を開いている間、画面に知らせて一覧を読み直させる。
// サーバーは1プロセスなので、メモリ上の購読で足りる。
import { errorFields, log } from "../log.js";

export type ChangeTopic = "shopping" | "reminders";
export type ChangeListener = (householdId: string, topic: ChangeTopic) => void;

export class ChangeFeed {
  private readonly listeners = new Set<ChangeListener>();

  notify(householdId: string, topic: ChangeTopic): void {
    for (const fn of this.listeners) {
      try {
        fn(householdId, topic);
      } catch (err) {
        log.error("change listener failed", errorFields(err));
      }
    }
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.listeners.size;
  }
}
