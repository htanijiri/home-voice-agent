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

/** Opus のフレームを、再生の速さに合わせて送る。最初の数フレームはまとめて送り、端末側の再生を途切れさせない */
export async function sendPaced(
  frames: Buffer[],
  send: (frame: Buffer) => void,
  signal: AbortSignal,
  opts: { preBuffer?: number; frameMs?: number } = {},
): Promise<void> {
  const pre = opts.preBuffer ?? 4;
  const frameMs = opts.frameMs ?? FRAME_MS;
  const start = Date.now();
  for (let i = 0; i < frames.length; i++) {
    if (signal.aborted) return;
    const due = start + Math.max(0, i - pre) * frameMs;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal.aborted) return;
    send(frames[i]!);
  }
  // 最後に送った分が再生され終わるまで待つ。UDP の音声が MQTT の「読み上げ終了」より後に着くと
  // 端末に捨てられるため、送り終えてから最低 100ms は空ける
  const tail = Math.max(100, start + frames.length * frameMs - Date.now() - pre * frameMs);
  if (!signal.aborted) await new Promise((r) => setTimeout(r, tail));
}
