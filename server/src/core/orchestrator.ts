// 1回の発話に対する応答を作る（LLM ＋ツール）。端末や通信方式には依存しない。
import type { Clock, LanguageModel } from "./ports.js";
import { cleanSpokenText, isSpeakable, SentenceSplitter } from "./sentence.js";
import type { ToolContext, ToolRegistry } from "./tools/registry.js";
import type { ChatMessage, ContentBlock, LlmUsage } from "./types.js";

export interface OrchestratorConfig {
  /** 最初の文が出るまでの上限（ミリ秒） */
  firstSentenceTimeoutMs: number;
  /** 応答全体の上限（ミリ秒） */
  totalTimeoutMs: number;
  /** ツールの往復の上限 */
  maxToolRounds: number;
}

export interface UsageSink {
  llm(model: string, usage: LlmUsage): void;
}

export class ConversationError extends Error {
  constructor(
    readonly kind: "llm" | "timeout" | "tool_loop",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export const REFUSAL_MESSAGE = "すみません、そのご質問にはお答えできません。";

export interface RespondInput {
  history: ChatMessage[];
  userText: string;
  ctx: ToolContext;
  /** システムからの補足（未通知のリマインダーなど）。ユーザーの発話の前に付ける */
  systemNotes?: string[];
  signal?: AbortSignal;
}

export class Orchestrator {
  constructor(
    private readonly llm: LanguageModel,
    private readonly tools: ToolRegistry,
    /** 固定のシステムプロンプト（キャッシュが効くよう、日時などの変わる値は入れない） */
    private readonly systemPrompt: string,
    /** 発話ごとに添える補足（現在の日時など） */
    private readonly turnNote: (now: Date) => string,
    private readonly clock: Clock,
    private readonly config: OrchestratorConfig,
    private readonly usage?: UsageSink,
  ) {}

  /**
   * 読み上げ用の文を順に返す。成功したときだけ、会話の履歴（input.history）に今回のやり取りを足す。
   */
  async *respond(input: RespondInput): AsyncGenerator<string, void, undefined> {
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let timedOut = false;
    let firstTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error("first sentence timeout"));
    }, this.config.firstSentenceTimeoutMs);
    const totalTimer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error("total timeout"));
    }, this.config.totalTimeoutMs);
    const clearFirst = () => {
      if (firstTimer) clearTimeout(firstTimer);
      firstTimer = undefined;
    };

    const now = this.clock.now();
    // 補足とユーザーの発話は、1つの文の中で見出しを付けて分ける。別々のかたまりにすると、モデルには区切りなく
    // つながって見え、「…洗剤」＋「日本で一番高い山は?」が「洗剤日本で一番高い山は?」と読まれた（実機で起きた）
    const notes = [this.turnNote(now), ...(input.systemNotes ?? []).map((n) => `（システムからの連絡）${n}`)].filter(Boolean);
    const text = notes.length
      ? `【補足（ユーザーには見えない）】\n${notes.join("\n")}\n\n【ユーザーの発話】\n${input.userText}`
      : input.userText;
    const userContent: ContentBlock[] = [{ type: "text", text }];
    const working: ChatMessage[] = [...input.history, { role: "user", content: userContent }];
    const system = this.systemPrompt;

    try {
      for (let round = 0; ; round++) {
        if (round > this.config.maxToolRounds) {
          throw new ConversationError("tool_loop", "too many tool rounds");
        }
        const splitter = new SentenceSplitter();
        let final: ChatMessage | undefined;
        let stopReason = "";
        try {
          for await (const ev of this.llm.stream({
            system,
            messages: working,
            tools: this.tools.definitions(),
            signal: ac.signal,
          })) {
            if (ev.type === "text_delta") {
              for (const s of splitter.push(ev.text)) {
                if (!isSpeakable(s)) continue;
                clearFirst();
                yield s;
              }
            } else {
              final = ev.message;
              stopReason = ev.stopReason;
              this.usage?.llm(this.llm.modelName, ev.usage);
            }
          }
        } catch (err) {
          if (timedOut) throw new ConversationError("timeout", "llm timeout", err);
          if (input.signal?.aborted) return;
          throw new ConversationError("llm", "llm failed", err);
        }
        for (const s of splitter.flush()) {
          if (!isSpeakable(s)) continue;
          clearFirst();
          yield s;
        }
        if (!final) throw new ConversationError("llm", "llm stream ended without a message");
        if (stopReason === "max_tokens" && final.content.some((b) => b.type === "tool_use")) {
          // ツールの呼び出しの途中で打ち切られた（考える分で上限に達した）。結果のないツールの呼び出しを履歴に残すと、
          // 次の問い合わせがエラーになるので、この回は失敗にする（013 の評価で起きた）
          throw new ConversationError("llm", "max_tokens during tool use");
        }
        if (stopReason === "refusal") {
          // 安全のために回答を断られた。履歴には残さない
          clearFirst();
          yield REFUSAL_MESSAGE;
          return;
        }
        // 履歴には、読み上げなかった文を残さない（漏れた英語の考えごとを、次の返事で真似させないため）
        working.push({
          ...final,
          content: final.content
            .map((b) => (b.type === "text" ? { ...b, text: cleanSpokenText(b.text) } : b))
            .filter((b) => b.type !== "text" || b.text.length > 0),
        });

        const toolUses = final.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
        );
        if (stopReason !== "tool_use" || toolUses.length === 0) break;

        // すべてのツールの結果を1つのメッセージで返す
        const runs = await Promise.all(toolUses.map((u) => this.tools.run(u.name, u.input, { ...input.ctx, now })));
        const results = runs.map((r, i) => ({
          type: "tool_result" as const,
          toolUseId: toolUses[i]!.id,
          content: r.content,
          isError: r.isError,
        }));
        working.push({ role: "user", content: results });

        // 操作がすべて思ったとおりにいったら、先に決めてあった返事（reply）を読み上げ、2回目の問い合わせをしない（012）
        const replies = toolUses.map((u) => {
          const r = (u.input as { reply?: unknown } | undefined)?.reply;
          return this.tools.acceptsReply(u.name) && typeof r === "string" ? r.trim() : "";
        });
        // 話しかけでない声を拾ったときなど、reply のない end_conversation だけなら、何も言わずに終える。
        // 拾った声を次の発話の文脈にしないよう、履歴にも残さない（013）
        if (toolUses.every((u) => this.tools.isTerminal(u.name)) && !replies.some(Boolean) && runs.every((r) => !r.isError)) {
          return;
        }
        // end_conversation のような terminal のツールは reply がなくてもよい（ほかのツールの reply で答えて終える）
        const replyReady = toolUses.every((u, i) => replies[i] || this.tools.isTerminal(u.name)) && replies.some(Boolean);
        if (replyReady && runs.every((r) => !r.isError && r.expected)) {
          const replySplitter = new SentenceSplitter();
          const spoken: string[] = [];
          for (const s of [...replySplitter.push(replies.join("")), ...replySplitter.flush()]) {
            if (!isSpeakable(s)) continue;
            clearFirst();
            spoken.push(s);
            yield s;
          }
          if (spoken.length > 0) {
            working.push({ role: "assistant", content: [{ type: "text", text: spoken.join("") }] });
            break;
          }
        }
      }
      // 成功したときだけ履歴を確定する。外部サービスの元のブロック（thinking など）は履歴に残さない
      input.history.splice(
        0,
        input.history.length,
        ...working.map(({ providerBlocks: _drop, ...m }) => m),
      );
    } finally {
      clearFirst();
      clearTimeout(totalTimer);
      input.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** 履歴を直近 maxTurns 往復に切り詰める。ツールの途中で切らないよう、ユーザーの発話（テキスト）の位置で切る */
export function trimHistory(history: ChatMessage[], maxTurns: number): void {
  const starts: number[] = [];
  history.forEach((m, i) => {
    if (m.role === "user" && m.content.some((b) => b.type === "text")) starts.push(i);
  });
  if (starts.length <= maxTurns) return;
  const cut = starts[starts.length - maxTurns]!;
  history.splice(0, cut);
}
