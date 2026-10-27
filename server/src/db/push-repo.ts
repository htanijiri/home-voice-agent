// Web Push の購読（016）。ブラウザごとに1行。ログインしている人のメールと結びつける
import type { PushTarget } from "../adapters/web-push.js";
import type { Db } from "./db.js";

export class PushRepo {
  constructor(private readonly db: Db) {}

  upsert(target: PushTarget, email: string, now: Date): void {
    this.db
      .prepare(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, email, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, email = excluded.email",
      )
      .run(target.endpoint, target.p256dh, target.auth, email, now.toISOString());
  }

  delete(endpoint: string): boolean {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
  }

  /** 許可リストから外れた人の購読も消す */
  deleteExcept(emails: string[]): number {
    const rows = this.all().filter((r) => !emails.includes(r.email));
    for (const r of rows) this.delete(r.endpoint);
    return rows.length;
  }

  has(endpoint: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  }

  all(): (PushTarget & { email: string })[] {
    return this.db.prepare("SELECT endpoint, p256dh, auth, email FROM push_subscriptions").all() as (PushTarget & {
      email: string;
    })[];
  }
}
