// サーバーでの話し始め・話し終わりの判定（011）。声の大きさだけで判断する。
// Google STT の話し始めの合図は、話し始めてから 0.6〜1.4 秒遅れて届くため、その前に打ち切らないよう自分でも気づく。
export interface LocalVadConfig {
  /** まわりの音の推定の何倍を声とみなすか */
  ratio: number;
  /** 声とみなす RMS の下限 */
  minRms: number;
  /** 声がこの長さ続いたら話し始め */
  startMs: number;
  /** 話し始めのあと、声でない状態がこの長さ続いたら話し終わり */
  endMs: number;
}

export const DEFAULT_LOCAL_VAD: LocalVadConfig = { ratio: 3, minRms: 50, startMs: 300, endMs: 800 };

const SAMPLE_RATE = 16000;
const FRAME_MS = 60;
const FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
/** まわりの音の推定が上がる速さ（1フレームごとに差の何割を足すか）。下がるときはすぐ下げる */
const NOISE_RISE = 0.02;

export type VadEvent = "start" | "end";

export class LocalVad {
  private noise?: number;
  private threshold = 0;
  private run = 0;
  private quiet = 0;
  private sum = 0;
  private n = 0;
  started = false;
  ended = false;
  /** 話し始めのあと、直前のフレームが声だった（本当の話し終わりの時刻を測るため。012） */
  voicedNow = false;

  /** 話し始めの前で、いま声らしい音が続いている（話し始めと判断する手前） */
  get rising(): boolean {
    return !this.started && this.run > 0;
  }

  constructor(private readonly cfg: LocalVadConfig = DEFAULT_LOCAL_VAD) {}

  /** PCM（16kHz）を受け取り、このとき起きた判定を返す */
  audio(pcm: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    for (const s of pcm) {
      this.sum += s * s;
      if (++this.n < FRAME) continue;
      const ev = this.frame(Math.sqrt(this.sum / FRAME));
      if (ev) events.push(ev);
      this.sum = 0;
      this.n = 0;
    }
    return events;
  }

  private frame(rms: number): VadEvent | undefined {
    if (this.ended) return undefined;
    if (!this.started) {
      // 最初から話していても声を雑音と思い込まないよう、推定の始まりは下限で抑える
      if (this.noise === undefined) this.noise = Math.min(rms, this.cfg.minRms);
      this.threshold = Math.max(this.noise * this.cfg.ratio, this.cfg.minRms);
      if (rms >= this.threshold) {
        if (++this.run * FRAME_MS >= this.cfg.startMs) {
          this.started = true;
          this.voicedNow = true;
          return "start";
        }
      } else {
        this.run = 0;
        this.noise = rms < this.noise ? rms : this.noise + (rms - this.noise) * NOISE_RISE;
      }
      return undefined;
    }
    // 話し始めのあとは、しきい値を固定して話し終わりを見る
    this.voicedNow = rms >= this.threshold;
    this.quiet = this.voicedNow ? 0 : this.quiet + 1;
    if (this.quiet * FRAME_MS >= this.cfg.endMs) {
      this.ended = true;
      return "end";
    }
    return undefined;
  }
}
