// 夜間の音量。夜間に入るときは、その時点の音量を覚えてから夜間の音量にし、朝になったら覚えた音量に戻す。
// 端末がつながっていない時刻をまたいだ場合は、次につながったとき（hello）に切り替える。
import type { AppConfig } from "../config.js";
import { isWithin, localTimeHHMM } from "../core/time.js";
import type { DeviceControl } from "../core/tools/registry.js";
import type { KvRepo } from "../db/kv-repo.js";
import { errorFields, log } from "../log.js";

type Period = "day" | "night";
interface State {
  period: Period;
  dayVolume?: number;
}

export class VolumePolicy {
  constructor(
    private readonly cfg: AppConfig["volume"],
    private readonly tz: string,
    private readonly kv: KvRepo,
  ) {}

  periodAt(now: Date): Period {
    return isWithin(localTimeHHMM(now, this.tz), this.cfg.nightStart, this.cfg.nightEnd) ? "night" : "day";
  }

  /** 運用のコマンドから、次につながったときに設定する音量を指定する（全部の端末） */
  request(volume: number): void {
    this.kv.set("volume:request", { volume: Math.max(0, Math.min(100, Math.round(volume))) });
  }

  /** 端末の音量を時間帯に合わせる。時間帯が変わったときだけ音量を送る */
  async apply(deviceId: string, device: DeviceControl, now: Date): Promise<void> {
    const key = `volume:${deviceId}`;
    // 運用から指定された音量があれば、先に設定する（いまの時間帯の音量として扱う）
    const req = this.kv.get<{ volume: number; done?: string[] }>("volume:request");
    if (req && !(req.done ?? []).includes(deviceId)) {
      try {
        await device.setVolume(req.volume);
        this.kv.set("volume:request", { ...req, done: [...(req.done ?? []), deviceId] });
        const period = this.periodAt(now);
        this.kv.set(key, period === "night" ? { period, dayVolume: this.cfg.day } : { period });
        log.info("volume request applied", { volume: req.volume });
      } catch (err) {
        log.warn("volume request failed", errorFields(err));
      }
      return;
    }
    const st = this.kv.get<State>(key);
    const period = this.periodAt(now);
    if (st?.period === period) return;
    try {
      if (period === "night") {
        const current = await device.getVolume().catch(() => undefined);
        await device.setVolume(this.cfg.night);
        this.kv.set(key, { period, dayVolume: current ?? st?.dayVolume ?? this.cfg.day });
      } else {
        // 初めての端末は、昼の音量を変えない
        if (st) await device.setVolume(st.dayVolume ?? this.cfg.day);
        this.kv.set(key, { period });
      }
      log.info("volume period applied", { period });
    } catch (err) {
      log.warn("volume apply failed", errorFields(err));
    }
  }
}
