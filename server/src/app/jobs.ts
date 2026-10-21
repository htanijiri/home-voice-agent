// 定期的な処理（1分ごとに確認する）：会話の記録の削除（毎日 4:00 と起動時）、など
import type { Clock } from "../core/ports.js";
import { localDateString, localTimeHHMM } from "../core/time.js";
import { errorFields, log } from "../log.js";

export interface Job {
  name: string;
  /** 毎日この時刻（HH:MM、日本時間）に実行する。省略すると毎分 */
  at?: string;
  runOnStart?: boolean;
  run(now: Date): Promise<void> | void;
}

export class JobRunner {
  private timer?: NodeJS.Timeout;
  private readonly lastRunDay = new Map<string, string>();

  constructor(
    private readonly jobs: Job[],
    private readonly clock: Clock,
    private readonly tz: string,
  ) {}

  start(intervalMs = 60_000): void {
    const now = this.clock.now();
    for (const j of this.jobs) {
      if (!j.runOnStart) continue;
      // 指定時刻を過ぎてから起動したときだけ、その日の分を実行済みにする
      if (j.at && localTimeHHMM(now, this.tz) >= j.at) this.lastRunDay.set(j.name, localDateString(now, this.tz));
      void this.exec(j, now);
    }
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    const now = this.clock.now();
    const hhmm = localTimeHHMM(now, this.tz);
    const day = localDateString(now, this.tz);
    for (const j of this.jobs) {
      if (j.at) {
        if (hhmm < j.at || this.lastRunDay.get(j.name) === day) continue;
        this.lastRunDay.set(j.name, day);
      }
      await this.exec(j, now);
    }
  }

  private async exec(j: Job, now: Date) {
    try {
      await j.run(now);
    } catch (err) {
      log.error("job failed", { job: j.name, ...errorFields(err) });
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
