// Opus の変換。端末からの音声は 16kHz・60ms、端末への音声は 24kHz・60ms のフレームにする。
import OpusScript from "opusscript";

export const UPLINK_RATE = 16000;
export const DOWNLINK_RATE = 24000;
export const FRAME_MS = 60;

export class OpusDecoder {
  private readonly dec = new OpusScript(UPLINK_RATE, 1, OpusScript.Application.VOIP);
  decode(packet: Buffer): Int16Array {
    const out = this.dec.decode(packet);
    return new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2).slice();
  }
  close() {
    this.dec.delete();
  }
}

export class OpusEncoder {
  private readonly enc: OpusScript;
  readonly frameSamples: number;
  constructor(readonly sampleRate = DOWNLINK_RATE) {
    this.enc = new OpusScript(sampleRate as 24000, 1, OpusScript.Application.AUDIO);
    this.frameSamples = (sampleRate * FRAME_MS) / 1000;
  }

  /** PCM を 60ms のフレームに区切って Opus にする。最後の半端は無音で埋める */
  encodeAll(pcm: Int16Array): Buffer[] {
    const frames: Buffer[] = [];
    for (let i = 0; i < pcm.length; i += this.frameSamples) {
      let chunk = pcm.subarray(i, i + this.frameSamples);
      if (chunk.length < this.frameSamples) {
        const padded = new Int16Array(this.frameSamples);
        padded.set(chunk);
        chunk = padded;
      }
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      frames.push(Buffer.from(this.enc.encode(buf, this.frameSamples)));
    }
    return frames;
  }
  close() {
    this.enc.delete();
  }
}

/** 標本化周波数の変換（線形補間）。TTS の出力が 24kHz でない場合に使う */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const ratio = from / to;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const f = x - i0;
    out[i] = Math.round(pcm[i0]! * (1 - f) + pcm[i1]! * f);
  }
  return out;
}

/**
 * Opus のフレームを、再生の速さに合わせて送る。最初の数フレームはまとめて送り、端末側の再生を途切れさせない。
 * フレームは何回かに分けて渡してよい（ストリーミングの合成で、できたところから送るため）。
 */
export class PacedSender {
  private start?: number;
  private sent = 0;
  private readonly pre: number;
  private readonly frameMs: number;

  constructor(
    private readonly send: (frame: Buffer) => void,
    private readonly signal: AbortSignal,
    opts: { preBuffer?: number; frameMs?: number } = {},
  ) {
    this.pre = opts.preBuffer ?? 4;
    this.frameMs = opts.frameMs ?? FRAME_MS;
  }

  async push(frames: Buffer[]): Promise<void> {
    for (const f of frames) {
      if (this.signal.aborted) return;
      const now = Date.now();
      this.start ??= now;
      let due = this.start + Math.max(0, this.sent - this.pre) * this.frameMs;
      // 合成が再生に追いつかず遅れたら、そこから数え直す（遅れた分を早送りしない。最後の待ちの計算も合う）
      if (due < now - this.frameMs) {
        this.start = now - Math.max(0, this.sent - this.pre) * this.frameMs;
        due = now;
      }
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.signal.aborted) return;
      this.send(f);
      this.sent++;
    }
  }

  /** 最後に送った分が再生され終わるまで待つ */
  async finish(): Promise<void> {
    if (this.start === undefined || this.signal.aborted) return;
    // UDP の音声が MQTT の「読み上げ終了」より後に着くと端末に捨てられるため、送り終えてから最低 100ms は空ける
    const tail = Math.max(100, this.start + this.sent * this.frameMs - Date.now() - this.pre * this.frameMs);
    await new Promise((r) => setTimeout(r, tail));
  }
}

/** Opus のフレームを、再生の速さに合わせて送る（まとめて渡す場合） */
export async function sendPaced(
  frames: Buffer[],
  send: (frame: Buffer) => void,
  signal: AbortSignal,
  opts: { preBuffer?: number; frameMs?: number } = {},
): Promise<void> {
  const p = new PacedSender(send, signal, opts);
  await p.push(frames);
  await p.finish();
}
