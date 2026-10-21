import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/core/orchestrator.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { MESSAGES, type TurnRecord, VoiceSession, type VoiceSessionConfig } from "../src/core/voice-session.js";
import { FakeClock, FakeLlm, FakeStt, FakeTts, RecordingSink, said } from "./fakes.js";

const baseCfg: VoiceSessionConfig = {
  followUpSeconds: 8,
  speechStartTimeoutSeconds: 6,
  maxUtteranceSeconds: 15,
  contextKeepMinutes: 5,
  maxHistoryTurns: 10,
};
const frame = new Int16Array(960);

function setup(opts: { llm: FakeLlm; stt: FakeStt; cfg?: Partial<VoiceSessionConfig>; limit?: string }) {
  const clock = new FakeClock();
  const tts = new FakeTts();
  const sink = new RecordingSink();
  const turns: TurnRecord[] = [];
  const orchestrator = new Orchestrator(opts.llm, new ToolRegistry(), "sys", () => "", clock, {
    firstSentenceTimeoutMs: 15000,
    totalTimeoutMs: 60000,
    maxToolRounds: 3,
  });
  const session = new VoiceSession(
    "dev1",
    "h1",
    {
      stt: opts.stt,
      tts,
      orchestrator,
      clock,
      config: { ...baseCfg, ...opts.cfg },
      hooks: { onTurn: (r) => turns.push(r), checkLimit: () => opts.limit },
    },
    sink,
  );
  return { session, sink, tts, clock, turns };
}

/** 非同期の処理を進める */
async function flush(times = 20) {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(0);
}

describe("VoiceSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("聞き取り → 認識 → 応答 → 読み上げ、のあと追加の聞き取りに入り、無言なら会話を終える", async () => {
    const stt = new FakeStt([said("日本で一番高い山は？"), "silent"]);
    const { session, sink, turns } = setup({ llm: new FakeLlm([{ text: "富士山です。" }]), stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(sink.events).toEqual([
      "stt:日本で一番高い山は？",
      "emotion:thinking",
      "tts:start",
      "sentence:富士山です。",
      "audio",
      "tts:stop",
    ]);
    expect(session.state).toBe("FOLLOW_UP");
    expect(turns[0]).toMatchObject({ outcome: "ok", userText: "日本で一番高い山は？", assistantText: "富士山です。" });
    await vi.advanceTimersByTimeAsync(8000);
    expect(sink.events.at(-1)).toBe("end");
    expect(session.state).toBe("IDLE");
  });

  it("読み上げのあとに端末が送る listen start では、追加の聞き取りをやり直さない（無言なら黙って終える）", async () => {
    const stt = new FakeStt([said("日本で一番高い山は？"), "silent", "silent"]);
    const { session, sink, tts } = setup({ llm: new FakeLlm([{ text: "富士山です。" }]), stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(session.state).toBe("FOLLOW_UP");
    session.onListenStart(); // 端末の自動の listen start
    await vi.advanceTimersByTimeAsync(8000);
    expect(sink.events.at(-1)).toBe("end");
    expect(tts.texts).not.toContain(MESSAGES.noSpeech);
  });

  it("追加の聞き取りで話すと、前の話を踏まえて応答する", async () => {
    const llm = new FakeLlm([{ text: "富士山です。" }, { text: "日本で一番高いからです。" }]);
    const stt = new FakeStt([said("日本で一番高い山は？"), said("それはどうして？")]);
    const { session } = setup({ llm, stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    session.onAudio(frame);
    await flush();
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages).toHaveLength(3); // 前の往復＋今回の質問
  });

  it("追加の聞き取りが 0 秒なら、読み上げのあとすぐ会話を終える", async () => {
    const stt = new FakeStt([said("こんにちは")]);
    const { session, sink } = setup({ llm: new FakeLlm([{ text: "こんにちは。" }]), stt, cfg: { followUpSeconds: 0 } });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(sink.events.at(-1)).toBe("end");
  });

  it("最初の聞き取りで話し始めがなければ「聞き取れませんでした」と言って終える", async () => {
    const { session, sink, tts } = setup({ llm: new FakeLlm([]), stt: new FakeStt(["silent"]) });
    session.onListenStart();
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(tts.texts).toEqual([MESSAGES.noSpeech]);
    expect(sink.events.at(-1)).toBe("end");
  });

  it("LLM が失敗したら案内を読み上げる", async () => {
    const stt = new FakeStt([said("こんにちは"), "silent"]);
    const { session, tts, turns } = setup({ llm: new FakeLlm([{ error: new Error("boom") }]), stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(tts.texts).toEqual([MESSAGES.serviceError]);
    expect(turns[0]).toMatchObject({ outcome: "error", errorKind: "llm" });
  });

  it("STT が失敗したら案内を読み上げて終える", async () => {
    const stt = new FakeStt([[{ type: "error", error: new Error("stt down") }]]);
    const { session, tts, sink } = setup({ llm: new FakeLlm([]), stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(tts.texts).toEqual([MESSAGES.serviceError]);
    expect(sink.events.at(-1)).toBe("end");
  });

  it("音声合成もできないときは、画面に案内を出す", async () => {
    const stt = new FakeStt([[{ type: "error", error: new Error("stt down") }]]);
    const { session, tts, sink } = setup({ llm: new FakeLlm([]), stt });
    tts.failWith = new Error("tts down");
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(sink.events).toContain(`stt:${MESSAGES.serviceError}`);
    expect(sink.events.at(-1)).toBe("end");
  });

  it("1日の上限を超えていたら、LLM を呼ばずに上限の案内を返す", async () => {
    const llm = new FakeLlm([{ text: "呼ばれないはず。" }]);
    const stt = new FakeStt([said("こんにちは"), "silent"]);
    const { session, tts, turns } = setup({ llm, stt, limit: "今日の利用上限に達しました。" });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(llm.requests).toHaveLength(0);
    expect(tts.texts).toEqual(["今日の利用上限に達しました。"]);
    expect(turns[0]!.outcome).toBe("limit");
  });

  it("前の会話から contextKeepMinutes を過ぎて話しかけると、前の話を忘れる", async () => {
    const llm = new FakeLlm([{ text: "一つ目です。" }, { text: "二つ目です。" }]);
    const stt = new FakeStt([said("一つ目"), "silent", said("二つ目")]);
    const { session, clock } = setup({ llm, stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    await vi.advanceTimersByTimeAsync(8000); // 追加の聞き取りが時間切れ
    clock.advance(6 * 60_000);
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(llm.requests[1]!.messages).toHaveLength(1);
  });

  it("contextKeepMinutes 以内なら前の話を覚えている", async () => {
    const llm = new FakeLlm([{ text: "一つ目です。" }, { text: "二つ目です。" }]);
    const stt = new FakeStt([said("一つ目"), "silent", said("二つ目")]);
    const { session, clock } = setup({ llm, stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    await vi.advanceTimersByTimeAsync(8000);
    clock.advance(4 * 60_000);
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(llm.requests[1]!.messages).toHaveLength(3);
  });

  it("読み上げ中の中断で、残りの文を送らない", async () => {
    const llm = new FakeLlm([{ hang: true }]);
    const stt = new FakeStt([said("長い話をして")]);
    const { session, sink } = setup({ llm, stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    session.onAbort();
    await flush();
    expect(sink.events).not.toContain("tts:start");
    expect(session.state).toBe("IDLE");
  });

  it("話し続けても maxUtteranceSeconds で区切る", async () => {
    const stt = new FakeStt([[{ type: "speech_start" }, { type: "final", text: "ずっと話している" }]]);
    const { session, sink } = setup({ llm: new FakeLlm([{ text: "はい、聞いています。" }]), stt });
    session.onListenStart();
    session.onAudio(frame);
    await flush();
    expect(sink.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(sink.events[0]).toBe("stt:ずっと話している");
  });
});
