// 聞き取り1回分の様子を数字で集める（009）。離れた場所から話すと聞き取れない原因を見分けるため。
// 音声そのものと認識した文章は持たない。
export interface ListenSummary {
  /** 届いた音声の長さ */
  audioMs: number;
  /** 聞き取りの開始から、最初の音声が届くまで */
  msToFirstAudio: number | null;
  /** 音声のパケットの間の最大の空き */
  maxGapMs: number;
  /** 60ms ごとの RMS の 10 パーセンタイル（まわりの音） */
  noiseRms: number | null;
  /** 60ms ごとの RMS の 90 パーセンタイル（声） */
  speechRms: number | null;
  /** 聞き取りの開始から、STT の話し始めの合図まで（来なければ null） */
  msToSpeechStart: number | null;
  /** 確定した結果の数 */
  finals: number;
  /** 確定した結果がすべて空だった（結果がないときも true） */
  emptyFinal: boolean;
  /** 「聞き取れませんでした」の理由。timeout：話し始めの合図が来ない／empty：合図は来たが結果が空 */
  noSpeechReason?: "timeout" | "empty";
}

const SAMPLE_RATE = 16000;
const FRAME = (SAMPLE_RATE * 60) / 1000;

export class ListenStats {
  private readonly startedAt: number;
  private samples = 0;
  private firstAudioAt?: number;
  private lastAudioAt?: number;
  private maxGap = 0;
  private readonly frameRms: number[] = [];
  private frameSum = 0;
  private frameN = 0;
  private speechStartAt?: number;
  private finals = 0;
  private nonEmptyFinals = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  audio(pcm: Int16Array): void {
    const t = this.now();
    if (this.firstAudioAt === undefined) this.firstAudioAt = t;
    else this.maxGap = Math.max(this.maxGap, t - this.lastAudioAt!);
    this.lastAudioAt = t;
    this.samples += pcm.length;
    for (const s of pcm) {
      this.frameSum += s * s;
      if (++this.frameN === FRAME) {
        this.frameRms.push(Math.sqrt(this.frameSum / FRAME));
        this.frameSum = 0;
        this.frameN = 0;
      }
    }
  }

  speechStart(): void {
    this.speechStartAt ??= this.now();
  }

  final(text: string): void {
    this.finals++;
    if (text.trim()) this.nonEmptyFinals++;
  }

  summary(noSpeechReason?: ListenSummary["noSpeechReason"]): ListenSummary {
    const sorted = [...this.frameRms].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!) : null);
    return {
      audioMs: Math.round((this.samples / SAMPLE_RATE) * 1000),
      msToFirstAudio: this.firstAudioAt === undefined ? null : this.firstAudioAt - this.startedAt,
      maxGapMs: this.maxGap,
      noiseRms: pct(0.1),
      speechRms: pct(0.9),
      msToSpeechStart: this.speechStartAt === undefined ? null : this.speechStartAt - this.startedAt,
      finals: this.finals,
      emptyFinal: this.nonEmptyFinals === 0,
      ...(noSpeechReason ? { noSpeechReason } : {}),
    };
  }
}
