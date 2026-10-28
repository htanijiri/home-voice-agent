import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/core/orchestrator.js";
import { conversationTools } from "../src/core/tools/conversation.js";
import { messageTools } from "../src/core/tools/messages.js";
import { type Tool, ToolRegistry } from "../src/core/tools/registry.js";
import { MESSAGES, type TurnRecord, VoiceSession, type VoiceSessionConfig } from "../src/core/voice-session.js";
import { FakeClock, FakeLlm, FakeStreamingTts, FakeStt, FakeTts, RecordingSink, said } from "./fakes.js";

const baseCfg: VoiceSessionConfig = {
  followUpSeconds: 8,
  speechStartTimeoutSeconds: 6,
  maxUtteranceSeconds: 15,
  contextKeepMinutes: 5,
  maxHistoryTurns: 10,
};
const frame = new Int16Array(960);

function setup(opts: {
  llm: FakeLlm;
  stt: FakeStt;
  cfg?: Partial<VoiceSessionConfig>;
  limit?: string;
  tts?: FakeTts;
  tools?: Tool[];
}) {
  const clock = new FakeClock();
  const tts = opts.tts ?? new FakeTts();
  const sink = new RecordingSink();
  const turns: TurnRecord[] = [];
  const orchestrator = new Orchestrator(opts.llm, new ToolRegistry().register(...conversationTools(), ...(opts.tools ?? [])), "sys", () => "", clock, {
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

  it("聞き取りの様子を記録する：話し始めの合図が来ない（timeout）／結果が空（empty）／うまくいった（009）", async () => {
    const loud = new Int16Array(960).fill(1000);
    const quiet = new Int16Array(960).fill(10);
    const stt = new FakeStt(["silent", [{ type: "speech_start" }, { type: "final", text: "" }, { type: "speech_end" }], said("こんにちは"), "silent"]);
    const { session, turns } = setup({ llm: new FakeLlm([{ text: "はい。" }]), stt, cfg: { followUpSeconds: 0 } });

    session.onListenStart();
    session.onAudio(quiet);
    await vi.advanceTimersByTimeAsync(120);
    session.onAudio(quiet);
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(turns[0]).toMatchObject({ outcome: "no_speech", listen: { noSpeechReason: "timeout", msToSpeechStart: null, finals: 0, emptyFinal: true, audioMs: 120, maxGapMs: 120, noiseRms: 10, speechRms: 10 } });

    session.onListenStart();
    session.onAudio(loud);
    await flush();
    expect(turns[1]).toMatchObject({ outcome: "no_speech", listen: { noSpeechReason: "empty", msToSpeechStart: 0, finals: 1, emptyFinal: true, speechRms: 1000 } });

    session.onListenStart();
    for (const f of [quiet, quiet, loud]) session.onAudio(f);
    await flush();
    expect(turns[2]!.outcome).toBe("ok");
    expect(turns[2]!.listen).toMatchObject({ finals: 1, emptyFinal: false, noiseRms: 10, speechRms: 1000 });
    expect(turns[2]!.listen!.noSpeechReason).toBeUndefined();
  });

  describe("聞き取りの打ち切り（011）", () => {
    const level = (rms: number) => new Int16Array(960).map((_, i) => (i % 2 ? rms : -rms));
    const send = async (session: VoiceSession, rms: number, frames: number) => {
      for (let i = 0; i < frames; i++) {
        session.onAudio(level(rms));
        await vi.advanceTimersByTimeAsync(60);
      }
    };

    it("待ち時間が過ぎても、届いた声は捨てずに STT を閉じて確定を待ち、その文章で答える", async () => {
      const stt = new FakeStt([{ afterEnd: [{ type: "final", text: "牛乳を追加して" }] }, "silent"]);
      const { session, tts, turns } = setup({ llm: new FakeLlm([{ text: "追加しました。" }]), stt, cfg: { followUpSeconds: 0 } });
      session.onListenStart();
      // サーバーの判定に届かない小さな声のまま 6 秒が過ぎる
      await send(session, 20, 100);
      await flush();
      // abort（声を捨てる）ではなく end して、返ってきた確定で答えた
      expect(stt.streams[0]!.ended).toBe(true);
      expect(tts.texts).toEqual(["追加しました。"]);
      expect(turns[0]).toMatchObject({ outcome: "ok", userText: "牛乳を追加して" });
    });

    it("待ち時間が過ぎて、確定も空なら「聞き取れませんでした」（理由は timeout）", async () => {
      const stt = new FakeStt([{ afterEnd: [] }]);
      const { session, tts, turns } = setup({ llm: new FakeLlm([]), stt });
      session.onListenStart();
      await send(session, 20, 100);
      await flush();
      expect(tts.texts).toEqual([MESSAGES.noSpeech]);
      expect(turns[0]).toMatchObject({ outcome: "no_speech", listen: { noSpeechReason: "timeout" } });
    });

    it("サーバーの判定で話し始めたら待ち時間で打ち切らず、静かになったら STT を閉じて確定を待つ", async () => {
      const stt = new FakeStt([{ afterEnd: [{ type: "final", text: "クロックムッシュを追加して" }] }, "silent"]);
      const { session, tts, turns } = setup({ llm: new FakeLlm([{ text: "追加しました。" }]), stt, cfg: { followUpSeconds: 0 } });
      session.onListenStart();
      await send(session, 20, 70); // 4.2 秒は静か
      await send(session, 100, 40); // 4.2 秒から 2.4 秒話す（6 秒をまたぐ）
      expect(stt.streams[0]!.ended).toBe(false);
      expect(tts.texts).toEqual([]);
      await send(session, 20, 25); // 1.2 秒静かになったら閉じる
      await flush();
      expect(stt.streams[0]!.ended).toBe(true);
      expect(tts.texts).toEqual(["追加しました。"]);
      expect(turns[0]!.listen).toMatchObject({ msToLocalSpeechStart: 4200 + 240, msToSpeechStart: null });
      // 本当の話し終わりは、最後に声だったときで、STT を閉じた時刻（0.8 秒後）より前（012）
      const t = turns[0]!.timings;
      expect(t.voiceEndAt).toBeDefined();
      expect(t.speechEndAt! - t.voiceEndAt!).toBeGreaterThanOrEqual(700);
      expect(t.firstAudioAt! >= t.voiceEndAt!).toBe(true);
    });

    it("待ち時間が切れる瞬間に話し始めていたら、話し始めと判断できるまで待つ（文の頭で切らない）", async () => {
      const stt = new FakeStt([{ afterEnd: [{ type: "final", text: "日本で一番高い山は" }] }, "silent"]);
      const { session, turns } = setup({ llm: new FakeLlm([{ text: "富士山です。" }]), stt, cfg: { followUpSeconds: 0 } });
      session.onListenStart();
      await send(session, 20, 98); // 5.88 秒まで静か
      await send(session, 100, 3); // 6 秒をまたいで話し始める
      expect(stt.streams[0]!.ended).toBe(false);
      await send(session, 100, 20);
      expect(stt.streams[0]!.ended).toBe(false);
      await send(session, 20, 25);
      await flush();
      expect(turns[0]).toMatchObject({ outcome: "ok", userText: "日本で一番高い山は" });
    });

    it("サーバーの判定で話し始めたが、確定が空なら「聞き取れませんでした」（理由は empty）", async () => {
      const stt = new FakeStt([{ afterEnd: [] }]);
      const { session, tts, turns } = setup({ llm: new FakeLlm([]), stt });
      session.onListenStart();
      await send(session, 20, 10);
      await send(session, 300, 10);
      await send(session, 20, 25);
      await flush();
      expect(tts.texts).toEqual([MESSAGES.noSpeech]);
      expect(turns[0]).toMatchObject({ outcome: "no_speech", listen: { noSpeechReason: "empty" } });
    });

    it("追加の聞き取りで話し始めがなければ、何も言わずに待機に戻る", async () => {
      const stt = new FakeStt([said("こんにちは"), "silent"]);
      const { session, tts, sink } = setup({ llm: new FakeLlm([{ text: "こんにちは。" }]), stt });
      session.onListenStart();
      session.onAudio(frame);
      await flush();
      await send(session, 20, 140);
      await flush();
      expect(tts.texts).toEqual(["こんにちは。"]);
      expect(sink.events.at(-1)).toBe("end");
      expect(stt.streams[1]!.aborted).toBe(true);
    });
  });

  describe("音声合成のストリーミング（012）", () => {
    it("ストリーミングの合成があれば使い、塊をすべて端末に送る", async () => {
      const tts = new FakeStreamingTts();
      const stt = new FakeStt([said("こんにちは"), "silent"]);
      const { session, sink } = setup({ llm: new FakeLlm([{ text: "こんにちは。元気です。" }]), stt, tts, cfg: { followUpSeconds: 0 } });
      session.onListenStart();
      session.onAudio(frame);
      await flush(60);
      expect(tts.streamed).toEqual(["こんにちは。", "元気です。"]);
      expect(tts.texts).toEqual([]);
      expect(sink.samples).toEqual([2500, 2500]);
    });

    it("最初の塊の前に失敗したら、まとめての合成でやり直す", async () => {
      const tts = new FakeStreamingTts();
      tts.streamFailWith = new Error("stream down");
      const stt = new FakeStt([said("こんにちは"), "silent"]);
      const { session, sink } = setup({ llm: new FakeLlm([{ text: "こんにちは。" }]), stt, tts, cfg: { followUpSeconds: 0 } });
      session.onListenStart();
      session.onAudio(frame);
      await flush(60);
      expect(tts.texts).toEqual(["こんにちは。"]);
      expect(sink.samples).toEqual([240]);
    });
  });

  describe("会話の終わり方（013）", () => {
    it("end_conversation に reply があれば読み上げ、続けての聞き取りをせずに待機に戻る", async () => {
      const stt = new FakeStt([said("もういいよ")]);
      const llm = new FakeLlm([{ toolUses: [{ name: "end_conversation", input: { reply: "はい、またね。" } }] }]);
      const { session, sink, tts, turns } = setup({ llm, stt });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      expect(tts.texts).toEqual(["はい、またね。"]);
      expect(sink.events.at(-1)).toBe("end");
      expect(stt.streams).toHaveLength(1);
      expect(session.state).toBe("IDLE");
      expect(turns[0]).toMatchObject({ outcome: "ok", assistantText: "はい、またね。" });
    });

    it("続けての聞き取りの発話には補足を添え、reply のない end_conversation なら黙って待機に戻る", async () => {
      const stt = new FakeStt([said("天気どう"), said("それでさ明日の会議なんだけど")]);
      const llm = new FakeLlm([{ text: "まだ天気にはつながっていません。" }, { toolUses: [{ name: "end_conversation", input: {} }] }]);
      const { session, sink, tts, turns } = setup({ llm, stt });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      session.onAudio(frame); // 続けての聞き取りで拾った声
      await flush(40);
      const noteOf = (i: number) => JSON.stringify(llm.requests[i]!.messages.at(-1));
      expect(noteOf(0)).not.toContain("続けての聞き取り");
      expect(noteOf(1)).toContain("続けての聞き取り");
      expect(tts.texts).toEqual(["まだ天気にはつながっていません。"]);
      expect(sink.events.at(-1)).toBe("end");
      expect(turns[1]).toMatchObject({ outcome: "ok", assistantText: "", errorKind: "ignored" });
      // 拾った声は、次の発話の文脈に残さない
      expect(session.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it("続けての聞き取りで「No reply」などだけを書いたら、読み上げずに黙って待機に戻り、履歴にも残さない", async () => {
      const stt = new FakeStt([said("天気どう"), said("うん")]);
      const llm = new FakeLlm([{ text: "まだ天気にはつながっていません。" }, { text: "No reply" }]);
      const { session, sink, tts, turns } = setup({ llm, stt });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      session.onAudio(frame);
      await flush(40);
      expect(tts.texts).toEqual(["まだ天気にはつながっていません。"]);
      expect(sink.events.at(-1)).toBe("end");
      expect(stt.streams).toHaveLength(2);
      expect(turns[1]).toMatchObject({ outcome: "ok", assistantText: "", errorKind: "ignored" });
      expect(session.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it("続けての聞き取りで言葉にならなかったときは「聞き取れませんでした」と言わずに待機に戻る", async () => {
      const stt = new FakeStt([said("こんにちは"), [{ type: "speech_start" }, { type: "final", text: "" }, { type: "speech_end" }]]);
      const { session, sink, tts, turns } = setup({ llm: new FakeLlm([{ text: "こんにちは。" }]), stt });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      session.onAudio(frame);
      await flush(40);
      expect(tts.texts).toEqual(["こんにちは。"]);
      expect(sink.events.at(-1)).toBe("end");
      expect(turns[1]).toMatchObject({ outcome: "no_speech", listen: { noSpeechReason: "empty" } });
    });
  });

  describe("連絡の用件をゆっくり聞く（017）", () => {
    const level = (rms: number) => new Int16Array(960).map((_, i) => (i % 2 ? rms : -rms));
    const send = async (session: VoiceSession, rms: number, frames: number) => {
      for (let i = 0; i < frames; i++) {
        session.onAudio(level(rms));
        await vi.advanceTimersByTimeAsync(60);
      }
    };
    const messenger = () => {
      const sent: { to?: string; text: string }[] = [];
      return { sent, tools: messageTools({ send: async (_hh, to, text) => void sent.push({ to, text }) }, 100) };
    };
    const ask = { name: "send_family_message", input: { to: "パパ", reply: "なんて伝える？" } };

    it("text なしで聞き返したら、2回目の LLM なしで読み上げ、次の聞き取りは途中の 2 秒の無言まで待って1つの用件にする", async () => {
      const m = messenger();
      const stt = new FakeStt([
        said("パパに連絡して"),
        // Google は「えっと」のあとの無言で話し終わりの合図を出すが、ゆっくり聞くときは止めない
        { events: [{ type: "speech_end" }], afterEnd: [{ type: "final", text: "えっと、お迎え何時？" }] },
        "silent",
      ]);
      const llm = new FakeLlm([
        { toolUses: [ask] },
        { toolUses: [{ name: "send_family_message", input: { to: "パパ", text: "えっと、お迎え何時？", reply: "パパに送ったよ。" } }] },
      ]);
      const { session, tts } = setup({ llm, stt, tools: m.tools });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      expect(tts.texts).toEqual(["なんて伝える？"]);
      expect(llm.requests).toHaveLength(1);
      expect(m.sent).toEqual([]);
      // Google が途中の無言で閉じないよう、サーバーの判定（2 秒）より長く待たせる
      expect(stt.opts[1]).toEqual({ speechEndSeconds: 3 });
      // ふだんの 8 秒を過ぎても、話し始めを待つ
      await send(session, 20, 170);
      expect(stt.streams[1]!.ended).toBe(false);
      expect(session.state).toBe("FOLLOW_UP");
      // 「えっと」→ 1.5 秒の無言 → 続き。ふだんなら 0.8 秒で閉じるところ
      await send(session, 100, 10);
      await send(session, 20, 25);
      expect(stt.streams[1]!.ended).toBe(false);
      await send(session, 100, 15);
      await send(session, 20, 35); // 2 秒静かになったら閉じる
      await flush(40);
      expect(stt.streams[1]!.ended).toBe(true);
      expect(m.sent).toEqual([{ to: "パパ", text: "えっと、お迎え何時？" }]);
      expect(tts.texts).toEqual(["なんて伝える？", "パパに送ったよ。"]);
      expect(JSON.stringify(llm.requests[1]!.messages.at(-1))).toContain("連絡の用件を聞き返したあと");
      // 印は1回だけ。そのあとの聞き取りは今までどおり
      expect(stt.opts[2]).toBeUndefined();
    });

    it("話し始めを 15 秒待っても話さなければ、何も言わずに待機に戻る", async () => {
      const m = messenger();
      const stt = new FakeStt([said("パパに連絡して"), "silent"]);
      const { session, tts, sink } = setup({ llm: new FakeLlm([{ toolUses: [ask] }]), stt, tools: m.tools });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      await send(session, 20, 245); // 14.7 秒
      expect(stt.streams[1]!.aborted).toBe(false);
      await send(session, 20, 10);
      await flush();
      expect(stt.streams[1]!.aborted).toBe(true);
      expect(sink.events.at(-1)).toBe("end");
      expect(tts.texts).toEqual(["なんて伝える？"]);
    });

    it("用件がつなぎの言葉だけなら送らずに聞き直し、次の聞き取りもゆっくり聞く", async () => {
      const m = messenger();
      const stt = new FakeStt([said("えっと"), "silent"]);
      const llm = new FakeLlm([
        { toolUses: [{ name: "send_family_message", input: { to: "パパ", text: "えっと", reply: "パパに送ったよ。" } }] },
        { text: "なんて伝える？" },
      ]);
      const { session, tts } = setup({ llm, stt, tools: m.tools });
      session.onListenStart();
      session.onAudio(frame);
      await flush(40);
      expect(m.sent).toEqual([]);
      expect(llm.requests).toHaveLength(2);
      expect(tts.texts).toEqual(["なんて伝える？"]);
      expect(stt.opts[1]).toEqual({ speechEndSeconds: 3 });
    });

    it("ふだんの聞き取りは、途中の 0.8 秒の無言で閉じる（今までどおり）", async () => {
      const stt = new FakeStt([{ afterEnd: [{ type: "final", text: "えっと" }] }, "silent"]);
      const { session, turns } = setup({ llm: new FakeLlm([{ text: "はい。" }]), stt, cfg: { followUpSeconds: 0 } });
      session.onListenStart();
      expect(stt.opts[0]).toBeUndefined();
      await send(session, 20, 10);
      await send(session, 100, 10);
      await send(session, 20, 15);
      await flush();
      expect(stt.streams[0]!.ended).toBe(true);
      expect(turns[0]).toMatchObject({ userText: "えっと" });
    });
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
