// リマインダーのスケジューラー。保存された次の通知時刻を見て、時刻が来たら端末に notify を送る。
//   - 読み上げのあと retryWaitSeconds（約 10 秒）のうちに反応（呼びかけ・ボタン・会話の開始）がなければ、すぐもう1回だけ送る（015）
//   - 会話中なら、会話が終わってから送る
//   - 端末がつながっていなければ待ち、遅れが maxLateMinutes 以内なら「遅れてお知らせします」を付けて送る。
//   - 読み上げるのは、登録した内容だけ（「〇〇の時間です」は付けない）。
//     それより古いものは missed にして、次の会話の最初に伝える
//   - 同じ回を二重に送らないよう、通知の記録（reminder_deliveries）は1回の予定につき1行にする
import type { Clock } from "../core/ports.js";
import { spokenDateTime } from "../core/reminders/speech.js";
import type { DeliveryRow, RemindersRepo } from "../db/reminders-repo.js";
import { errorFields, log } from "../log.js";
import type { Announcer } from "./announcer.js";
import type { DeviceHub } from "./hub.js";

export interface ReminderSchedulerConfig {
  tz: string;
  /** 読み上げが終わってから、反応を待つ秒数（015） */
  retryWaitSeconds: number;
  maxLateMinutes: number;
}

const LATE_THRESHOLD_MS = 60_000;

/**
 * notify を送ってから読み上げが終わるまでの見込み（015）。端末からは終わりの知らせが来ないので、
 * 音声を取りに来る時間（TLS の接続を含め約 3.5 秒）＋チャイム（約 1.5 秒）＋文字数 × 0.17 秒で見積もる
 */
export function notifyPlaybackMs(text: string): number {
  return 3500 + 1500 + [...text].length * 170;
}

/** 読み上げる文。登録した内容をそのまま読み、文の終わりに句点がなければ足す */
export function notifyText(rows: DeliveryRow[], late: boolean): string {
  const body = [...new Set(rows.map((r) => r.title.trim()))].map((t) => (/[。．.！!？?…]$/.test(t) ? t : `${t}。`)).join("");
  return late ? `遅れてお知らせします。${body}` : body;
}

export class ReminderScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly offHub: () => void;

  constructor(
    private readonly repo: RemindersRepo,
    hub: DeviceHub,
    private readonly announcer: Announcer,
    private readonly clock: Clock,
    private readonly cfg: ReminderSchedulerConfig,
  ) {
    // 端末の反応（会話の開始・呼びかけ・ボタン）があれば、送った通知は届いたものとする
    this.offHub = hub.on((e) => {
      if (e.type === "activity") this.acknowledge(this.clock.now());
      if (e.type === "online") void this.tick();
    });
  }

  start(intervalMs = 2_000) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.offHub();
  }

  acknowledge(now: Date) {
    const sent = this.repo.deliveries(["sent"]).filter((d) => d.sent_at && d.sent_at <= now.toISOString());
    if (sent.length) this.repo.setState(sent.map((d) => d.id), "acknowledged", now);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.clock.now();
      // 1. 時刻が来たものを通知の記録にし、次回へ進める
      for (const r of this.repo.due(now)) this.repo.takeDue(r);

      // 2. 古すぎる未送信は missed にする
      const maxLate = this.cfg.maxLateMinutes * 60_000;
      const pending = this.repo.deliveries(["pending"]);
      const tooLate = pending.filter((d) => now.getTime() - Date.parse(d.scheduled_at) > maxLate);
      if (tooLate.length) this.repo.setState(tooLate.map((d) => d.id), "missed");
      const sendable = pending.filter((d) => !tooLate.includes(d));

      // 3. 1回目を送ったが反応がないものは、もう1回（2回目のあとは done）
      const sent = this.repo.deliveries(["sent"]);
      // retry_at のない古い行（015 より前に送ったもの）は、送ってから 5 分とする
      const due = (d: DeliveryRow) => now.getTime() >= (d.retry_at ? Date.parse(d.retry_at) : Date.parse(d.sent_at!) + 300_000);
      const finished = sent.filter((d) => d.attempts >= 2 && due(d));
      if (finished.length) this.repo.setState(finished.map((d) => d.id), "done");
      const retry = sent.filter((d) => d.attempts === 1 && due(d));

      if (this.announcer.targets().length === 0) return;
      const idle = this.announcer.idleTargets();
      if (idle.length === 0) {
        // 会話中の人がいる＝近くにいるので、2回目は送らずに届いたものとする
        if (retry.length) this.repo.setState(retry.map((d) => d.id), "acknowledged", now);
        return;
      }

      const first = sendable;
      if (first.length) {
        const late = first.some((d) => now.getTime() - Date.parse(d.scheduled_at) > LATE_THRESHOLD_MS);
        await this.send(idle, first, notifyText(first, late));
      }
      if (retry.length) await this.send(idle, retry, notifyText(retry, false));
    } catch (err) {
      log.error("reminder tick failed", errorFields(err));
    } finally {
      this.running = false;
    }
  }

  private async send(deviceIds: string[], rows: DeliveryRow[], text: string): Promise<void> {
    // 先に送信済みにして、二重に送らないようにする
    const now = this.clock.now();
    const retryAt = new Date(now.getTime() + notifyPlaybackMs(text) + this.cfg.retryWaitSeconds * 1000);
    this.repo.markSent(rows.map((r) => r.id), now, retryAt);
    await this.announcer.send(deviceIds, text, "リマインダー");
    log.info("reminder notified", { count: rows.length, attempt: (rows[0]?.attempts ?? 0) + 1 });
  }

  /** 伝えられなかったリマインダー（次の会話の最初に LLM へ渡す） */
  pendingNotes(): { notes: string[]; consume(): void } | undefined {
    const missed = this.repo.deliveries(["missed"]);
    if (missed.length === 0) return undefined;
    const list = missed.map((d) => `${d.title}（${spokenDateTime(new Date(d.scheduled_at), this.cfg.tz)}）`).join("、");
    return {
      notes: [`お知らせできなかったリマインダーがあります：${list}。返事の最初に、このことを短く伝えてください。`],
      consume: () => this.repo.setState(missed.map((d) => d.id), "told"),
    };
  }
}
