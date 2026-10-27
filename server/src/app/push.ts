// 家族のスマホへの通知（016）。鍵は初めて起動したときに作って kv に置き、購読しているブラウザすべてに送る。
// 通知の中身はログに出さない（送った数だけ）。
import { generateVapidKeys, isAllowedEndpoint, type PushSender, type PushTarget, type VapidKeys } from "../adapters/web-push.js";
import type { KvRepo } from "../db/kv-repo.js";
import type { PushRepo } from "../db/push-repo.js";
import { errorFields, log } from "../log.js";

const KV_KEY = "web_push_vapid";

export interface PushPayload {
  title: string;
  body: string;
  /** 押したときに開く場所 */
  url: string;
}

/** 保存してある鍵を返す。なければ作って保存する */
export function loadOrCreateVapidKeys(kv: KvRepo): VapidKeys {
  const saved = kv.get<VapidKeys>(KV_KEY);
  if (saved?.publicKey && saved.privateKey) return saved;
  const keys = generateVapidKeys();
  kv.set(KV_KEY, keys);
  log.info("web push keys created");
  return keys;
}

export class PushService {
  constructor(
    private readonly repo: PushRepo,
    private readonly sender: PushSender,
    readonly publicKey: string,
  ) {}

  subscribe(target: PushTarget, email: string, now: Date): void {
    if (!isAllowedEndpoint(target.endpoint)) throw new Error("この通知の送り先には対応していません");
    if (!target.p256dh || !target.auth) throw new Error("通知の購読の情報が足りません");
    this.repo.upsert(target, email, now);
  }

  unsubscribe(endpoint: string): void {
    this.repo.delete(endpoint);
  }

  /** 確認画面に入れなくなった人の購読を消す */
  removeExcept(emails: string[]): number {
    return this.repo.deleteExcept(emails);
  }

  isSubscribed(endpoint: string): boolean {
    return this.repo.has(endpoint);
  }

  /** 購読しているブラウザすべてに送る。もう使われていない購読（404・410）は消す */
  async notifyAll(payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
    const body = JSON.stringify(payload);
    let sent = 0;
    let removed = 0;
    let failed = 0;
    await Promise.all(
      this.repo.all().map(async (t) => {
        try {
          const status = await this.sender.send(t, body);
          if (status === 404 || status === 410) {
            this.repo.delete(t.endpoint);
            removed++;
          } else if (status >= 200 && status < 300) {
            sent++;
          } else {
            failed++;
            log.warn("web push rejected", { status });
          }
        } catch (err) {
          failed++;
          log.warn("web push failed", errorFields(err));
        }
      }),
    );
    log.info("web push", { sent, removed, failed });
    return { sent, removed, failed };
  }
}
