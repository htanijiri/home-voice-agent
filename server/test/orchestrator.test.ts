import { describe, expect, it } from "vitest";
import { ConversationError, Orchestrator, trimHistory } from "../src/core/orchestrator.js";
import { SentenceSplitter } from "../src/core/sentence.js";
import { ToolRegistry } from "../src/core/tools/registry.js";
import type { ChatMessage } from "../src/core/types.js";
import { FakeClock, FakeLlm } from "./fakes.js";

const cfg = { firstSentenceTimeoutMs: 1000, totalTimeoutMs: 5000, maxToolRounds: 3 };
const ctx = { deviceId: "d1", householdId: "h1", now: new Date() };

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
}

describe("SentenceSplitter", () => {
  it("句点・感嘆符・疑問符で区切る", () => {
    const sp = new SentenceSplitter();
    expect(sp.push("こんにちは。今日は")).toEqual(["こんにちは。"]);
    expect(sp.push("いい天気ですね！本当に？")).toEqual(["今日はいい天気ですね！", "本当に？"]);
    expect(sp.flush()).toEqual([]);
  });
  it("短すぎる断片は次の文とまとめる", () => {
    const sp = new SentenceSplitter(4);
    expect(sp.push("はい。富士山です。")).toEqual(["はい。富士山です。"]);
  });
  it("残りは flush で返す", () => {
    const sp = new SentenceSplitter();
    sp.push("終わりのない文");
    expect(sp.flush()).toEqual(["終わりのない文"]);
  });
});

describe("Orchestrator", () => {
  it("1往復の会話で文を返し、履歴に足す", async () => {
    const llm = new FakeLlm([{ text: "富士山です。高さは3776メートルです。" }]);
    const o = new Orchestrator(llm, new ToolRegistry(), "sys", () => "", new FakeClock(), cfg);
    const history: ChatMessage[] = [];
    const out = await collect(o.respond({ history, userText: "日本で一番高い山は？", ctx }));
    expect(out).toEqual(["富士山です。", "高さは3776メートルです。"]);
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe("user");
    expect(history[1]!.role).toBe("assistant");
  });

  it("ツールを実行して結果を返し、続きの応答を読む", async () => {
    const llm = new FakeLlm([
      { toolUses: [{ name: "echo", input: { value: "牛乳" } }] },
      { text: "牛乳を追加しました。" },
    ]);
    const tools = new ToolRegistry().register({
      def: {
        name: "echo",
        description: "test",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
      run: async (input) => ({ got: input.value }),
    });
    const o = new Orchestrator(llm, tools, "sys", () => "", new FakeClock(), cfg);
    const history: ChatMessage[] = [];
    const out = await collect(o.respond({ history, userText: "牛乳を入れて", ctx }));
    expect(out).toEqual(["牛乳を追加しました。"]);
    const second = llm.requests[1]!.messages;
    const last = second[second.length - 1]!;
    expect(last.content[0]).toMatchObject({ type: "tool_result", toolUseId: "tu_0", content: '{"got":"牛乳"}' });
    expect(history).toHaveLength(4);
  });

  it("ツールの入力が不正なら、エラーとして LLM に返す", async () => {
    const llm = new FakeLlm([{ toolUses: [{ name: "echo", input: {} }] }, { text: "失敗しました。" }]);
    const tools = new ToolRegistry().register({
      def: { name: "echo", description: "", inputSchema: { type: "object", required: ["value"] } },
      run: async () => ({}),
    });
    const o = new Orchestrator(llm, tools, "sys", () => "", new FakeClock(), cfg);
    await collect(o.respond({ history: [], userText: "x", ctx }));
    const msgs = llm.requests[1]!.messages;
    expect(msgs[msgs.length - 1]!.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("LLM が失敗したら ConversationError を投げ、履歴は変えない", async () => {
    const llm = new FakeLlm([{ error: new Error("500") }]);
    const o = new Orchestrator(llm, new ToolRegistry(), "sys", () => "", new FakeClock(), cfg);
    const history: ChatMessage[] = [];
    await expect(collect(o.respond({ history, userText: "x", ctx }))).rejects.toMatchObject({ kind: "llm" });
    expect(history).toHaveLength(0);
  });

  it("最初の文が時間内に出なければ timeout になる", async () => {
    const llm = new FakeLlm([{ hang: true }]);
    const o = new Orchestrator(llm, new ToolRegistry(), "sys", () => "", new FakeClock(), {
      ...cfg,
      firstSentenceTimeoutMs: 50,
    });
    const err = await collect(o.respond({ history: [], userText: "x", ctx })).catch((e) => e);
    expect(err).toBeInstanceOf(ConversationError);
    expect(err.kind).toBe("timeout");
  });

  it("ツールの往復が上限を超えたら止める", async () => {
    const loop = { toolUses: [{ name: "noop", input: {} }] };
    const llm = new FakeLlm([loop, loop, loop, loop, loop, loop]);
    const tools = new ToolRegistry().register({
      def: { name: "noop", description: "", inputSchema: { type: "object" } },
      run: async () => ({}),
    });
    const o = new Orchestrator(llm, tools, "sys", () => "", new FakeClock(), cfg);
    await expect(collect(o.respond({ history: [], userText: "x", ctx }))).rejects.toMatchObject({
      kind: "tool_loop",
    });
  });

  it("システムからの補足を、ユーザーの発話の前に付ける", async () => {
    const llm = new FakeLlm([{ text: "はい、わかりました。" }]);
    const o = new Orchestrator(llm, new ToolRegistry(), "sys", () => "", new FakeClock(), cfg);
    await collect(o.respond({ history: [], userText: "こんにちは", ctx, systemNotes: ["未通知があります"] }));
    const first = llm.requests[0]!.messages[0]!;
    expect(first.content).toHaveLength(1);
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("未通知があります") });
    expect((first.content[0] as { text: string }).text).toMatch(/【ユーザーの発話】\nこんにちは$/);
  });
});

describe("trimHistory", () => {
  it("直近 N 往復に切り詰め、ツールの途中では切らない", () => {
    const h: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      h.push({ role: "user", content: [{ type: "text", text: `q${i}` }] });
      h.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
      h.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "{}" }] });
      h.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    }
    trimHistory(h, 2);
    expect(h).toHaveLength(8);
    expect(h[0]!.content[0]).toMatchObject({ text: "q3" });
  });
});

describe("Orchestrator（補足と拒否）", () => {
  it("発話ごとの補足（日時）をユーザーの発話の前に付ける", async () => {
    const llm = new FakeLlm([{ text: "はい、そうです。" }]);
    const o = new Orchestrator(llm, new ToolRegistry(), "sys", () => "現在の日時：テスト", new FakeClock(), {
      firstSentenceTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      maxToolRounds: 3,
    });
    const out: string[] = [];
    for await (const s of o.respond({ history: [], userText: "今日は何日？", ctx: { deviceId: "d", householdId: "h", now: new Date() } }))
      out.push(s);
    expect(llm.requests[0]!.system).toBe("sys");
    expect(llm.requests[0]!.messages[0]!.content[0]).toMatchObject({
      text: "【補足（ユーザーには見えない）】\n現在の日時：テスト\n\n【ユーザーの発話】\n今日は何日？",
    });
  });
});

describe("読み上げない文", () => {
  it("英語の考えごとは読み上げず、日本語の返事の中の英単語は残す", async () => {
    const { isSpeakable } = await import("../src/core/sentence.js");
    expect(isSpeakable("Ask: the list is empty, so adding milk is straightforward.")).toBe(false);
    expect(isSpeakable("MQTTのテストです。")).toBe(true);
    expect(isSpeakable("iPhoneの充電を忘れないでください。")).toBe(true);
    expect(isSpeakable("<thinking>")).toBe(false);
  });
  it("漏れた英語を区切って取り除き、履歴にも残さない", async () => {
    const llm = new FakeLlm([{ text: "Ask: the list is empty, so adding milk is straightforward.牛乳を追加しました。" }]);
    const o = new Orchestrator(llm, new ToolRegistry(), "sys", () => "", new FakeClock(), cfg);
    const history: ChatMessage[] = [];
    expect(await collect(o.respond({ history, userText: "牛乳", ctx }))).toEqual(["牛乳を追加しました。"]);
    expect(history[1]!.content[0]).toMatchObject({ text: "牛乳を追加しました。" });
  });
});

describe("外部サービスの元のブロック", () => {
  it("いまの返事の中（ツールの往復）では返し、履歴には残さない", async () => {
    const llm = new FakeLlm([{ toolUses: [{ name: "noop", input: {} }] }, { text: "できました。" }]);
    // 偽の LLM の返事に、元のブロックを付ける
    const orig = llm.stream.bind(llm);
    llm.stream = async function* (req) {
      for await (const ev of orig(req)) {
        if (ev.type === "done") yield { ...ev, message: { ...ev.message, providerBlocks: [{ type: "thinking", signature: "s" }] } };
        else yield ev;
      }
    };
    const tools = new ToolRegistry().register({ def: { name: "noop", description: "", inputSchema: { type: "object" } }, run: async () => ({}) });
    const o = new Orchestrator(llm, tools, "sys", () => "", new FakeClock(), cfg);
    const history: ChatMessage[] = [];
    await collect(o.respond({ history, userText: "x", ctx }));
    // 2回目の要求（ツールの結果を返すとき）には、元のブロックが付いている
    expect(llm.requests[1]!.messages[1]!.providerBlocks).toEqual([{ type: "thinking", signature: "s" }]);
    // 履歴には残らない
    expect(history.every((m) => m.providerBlocks === undefined)).toBe(true);
  });
});
