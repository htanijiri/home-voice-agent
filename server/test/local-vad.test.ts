// 011：サーバーでの話し始め・話し終わりの判定
import { describe, expect, it } from "vitest";
import { LocalVad } from "../src/core/local-vad.js";

/** 60ms のフレームを、決めた RMS（矩形波）で作る */
const frame = (rms: number) => {
  const f = new Int16Array(960);
  for (let i = 0; i < f.length; i++) f[i] = i % 2 ? rms : -rms;
  return f;
};
const feed = (vad: LocalVad, rms: number, frames: number) => {
  const evs: { at: number; ev: string }[] = [];
  for (let i = 0; i < frames; i++) for (const ev of vad.audio(frame(rms))) evs.push({ at: i, ev });
  return evs;
};

describe("LocalVad", () => {
  it("まわりの音の 3 倍以上の声が 300ms 続いたら話し始め、1.2 秒静かになったら話し終わり", () => {
    const vad = new LocalVad();
    expect(feed(vad, 20, 30)).toEqual([]);
    // 遠くの声（009 の記録：雑音 18〜20 に対して 82〜104）
    expect(feed(vad, 90, 10)).toEqual([{ at: 4, ev: "start" }]);
    expect(feed(vad, 25, 19)).toEqual([]);
    expect(feed(vad, 25, 1)).toEqual([{ at: 0, ev: "end" }]);
    expect(feed(vad, 90, 10)).toEqual([]);
  });

  it("短い物音（300ms 未満）では話し始めにしない", () => {
    const vad = new LocalVad();
    feed(vad, 20, 10);
    expect(feed(vad, 400, 4)).toEqual([]);
    expect(feed(vad, 20, 10)).toEqual([]);
    expect(vad.started).toBe(false);
  });

  it("下限（50）より小さい音は、雑音がとても静かでも声にしない", () => {
    const vad = new LocalVad();
    feed(vad, 5, 10);
    expect(feed(vad, 40, 20)).toEqual([]);
  });

  it("換気扇のような一定の音では話し始めにせず、しきい値はその音に合わせて上がる", () => {
    const vad = new LocalVad();
    expect(feed(vad, 70, 100)).toEqual([]);
    // しきい値は 70 の 3 倍の 210 前後になっている
    expect(feed(vad, 180, 10)).toEqual([]);
    expect(feed(vad, 70, 5)).toEqual([]);
    expect(feed(vad, 260, 10)).toEqual([{ at: 4, ev: "start" }]);
  });

  it("最初から話していても話し始めに気づく", () => {
    const vad = new LocalVad();
    expect(feed(vad, 300, 6)).toEqual([{ at: 4, ev: "start" }]);
  });

  it("フレームの区切りがずれた PCM でも数える", () => {
    const vad = new LocalVad();
    const pcm = new Int16Array(960 * 10);
    pcm.fill(200);
    const evs = [...vad.audio(pcm.subarray(0, 1000)), ...vad.audio(pcm.subarray(1000, 5000)), ...vad.audio(pcm.subarray(5000))];
    expect(evs).toEqual(["start"]);
  });
});
