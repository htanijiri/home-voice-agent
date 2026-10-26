// 端末に、チャイムのあとの読み上げ（notify）を送る。リマインダーと、確認画面からの読み上げ（014）で使う。
//   - 音声（Ogg Opus）は、1回だけ取り出せる URL で配る。待機中の端末でも鳴る
//   - 会話中の端末には送らない。確認画面からの読み上げは、会話が終わるまで最大 2 分待つ
//   - 読み上げる文章はログに出さない（文字数だけ）
import type { Clock, TextToSpeech } from "../core/ports.js";
import { errorFields, log } from "../log.js";
import type { DeviceHub } from "./hub.js";
import type { NotifyAudioStore } from "./notify-audio.js";

export interface AnnouncerConfig {
  publicBaseUrl: () => string;
  /** 送る前に呼ぶ（夜間の音量など） */
  beforeNotify?: (deviceId: string) => Promise<void>;
  /** 会話中のとき、終わるのを待つ上限 */
  maxWaitMs?: number;
}

export type AnnounceStatus = "sent" | "queued" | "offline" | "busy";

/** 待ち行列に置ける数（家族数人の伝言なので少なくてよい） */
const MAX_QUEUE = 5;

export class Announcer {
  private readonly queue: { text: string; expiresAt: number }[] = [];
  private timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(
    private readonly hub: DeviceHub,
    private readonly tts: TextToSpeech,
    private readonly audio: NotifyAudioStore,
    private readonly clock: Clock,
    private readonly cfg: AnnouncerConfig,
  ) {}

  /** 通知できる端末（MQTT でつながっている。WebSocket の端末は待機中に通路がない） */
  targets(): string[] {
    return this.hub.onlineDevices().filter((id) => this.hub.getLink(id)?.kind === "mqtt");
  }

  /** 会話中でない、通知できる端末 */
  idleTargets(): string[] {
    return this.targets().filter((id) => !this.hub.isBusy(id));
  }

  /** 確認画面からの読み上げ。待機中ならすぐ送り、会話中なら終わるのを待つ */
  async announce(text: string): Promise<AnnounceStatus> {
    if (this.targets().length === 0) return "offline";
    const idle = this.idleTargets();
    if (idle.length > 0) {
      await this.send(idle, text, "お知らせ");
      return "sent";
    }
    if (this.queue.length >= MAX_QUEUE) return "busy";
    this.queue.push({ text, expiresAt: this.clock.now().getTime() + (this.cfg.maxWaitMs ?? 120_000) });
    log.info("announce queued", { chars: [...text].length });
    this.timer ??= setInterval(() => void this.flush(), 5_000);
    this.timer.unref?.();
    return "queued";
  }

  /** 待っている読み上げを、待機に戻った端末に送る。古すぎるものは捨てる */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = this.clock.now().getTime();
      const expired = this.queue.filter((q) => q.expiresAt < now);
      if (expired.length) {
        this.queue.splice(0, this.queue.length, ...this.queue.filter((q) => q.expiresAt >= now));
        log.info("announce dropped", { count: expired.length });
      }
      const idle = this.idleTargets();
      if (idle.length > 0 && this.queue.length > 0) {
        const items = this.queue.splice(0);
        await this.send(idle, items.map((q) => q.text).join(""), "お知らせ");
      }
      if (this.queue.length === 0) this.stop();
    } finally {
      this.flushing = false;
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** notify を送る。音声が作れないときは、画面の表示と通知音で知らせる */
  async send(deviceIds: string[], text: string, alertStatus: string): Promise<void> {
    let url: string | undefined;
    try {
      const { ogg } = await this.tts.synthesizeOggOpus(text);
      url = `${this.cfg.publicBaseUrl()}/notify/audio/${this.audio.put(ogg)}.ogg`;
    } catch (err) {
      log.warn("notify tts failed", errorFields(err));
    }
    for (const id of deviceIds) {
      await this.cfg.beforeNotify?.(id).catch(() => undefined);
      const link = this.hub.getLink(id);
      if (!link) continue;
      if (url) {
        link.sendJson({ type: "notify", audio_url: url, subtitles: [{ start_ms: 0, text }] });
      } else {
        link.sendJson({ type: "alert", status: alertStatus, message: text, emotion: "neutral" });
      }
    }
    log.info("announced", { kind: alertStatus, chars: [...text].length, devices: deviceIds.length });
  }
}
