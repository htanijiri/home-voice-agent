// 評価用：実際の Claude と本物のツール（メモリ上のデータベース）で、文字の会話を流す。音声認識と読み上げは使わない。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlm } from "../../src/adapters/llm-anthropic.js";
import { loadConfig, loadDotEnv } from "../../src/config.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import type { Clock } from "../../src/core/ports.js";
import { makeTurnNote } from "../../src/core/turn-note.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { reminderTools } from "../../src/core/tools/reminders.js";
import { shoppingTools } from "../../src/core/tools/shopping.js";
import { conversationTools } from "../../src/core/tools/conversation.js";
import { messageTools } from "../../src/core/tools/messages.js";
import { FOLLOW_UP_NOTE, PATIENT_NOTE } from "../../src/core/voice-session.js";
import type { ChatMessage } from "../../src/core/types.js";
import { openDb } from "../../src/db/db.js";
import { RemindersRepo } from "../../src/db/reminders-repo.js";
import { ShoppingRepo } from "../../src/db/shopping-repo.js";

loadDotEnv(resolve(process.cwd(), ".env"));
export const config = loadConfig();
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません");
export const anthropic = new Anthropic({ apiKey });

export function newWorld(now = new Date("2026-10-20T10:00:00+09:00")) {
  const db = openDb(":memory:");
  const shopping = new ShoppingRepo(db);
  const reminders = new RemindersRepo(db, "Asia/Tokyo");
  /** 家族への連絡（016）。送ったものを覚えておく */
  const sent: { to?: string; text: string }[] = [];
  const tools = new ToolRegistry().register(
    ...shoppingTools(shopping),
    ...reminderTools(reminders, "Asia/Tokyo"),
    ...conversationTools(),
    ...messageTools({ send: async (_hh, to, text) => void sent.push({ to, text }) }, 100),
  );
  const clock: Clock = { now: () => now };
  const llm = new AnthropicLlm({ apiKey: apiKey!, ...config.llm });
  const o = new Orchestrator(
    llm,
    tools,
    readFileSync(resolve("prompts/system.md"), "utf8"),
    makeTurnNote(shopping, "home", "Asia/Tokyo"),
    clock,
    { firstSentenceTimeoutMs: 30_000, totalTimeoutMs: 60_000, maxToolRounds: 4 },
  );
  const history: ChatMessage[] = [];
  const firstSentenceMs: number[] = [];
  const state = { ended: false, patient: false };
  /**
   * followUp：返事のあとの、呼びかけなしの続けての聞き取りとして渡す（013）。
   * 前の回で連絡の用件を聞き返していたら（017）、続けての聞き取りに PATIENT_NOTE も添える
   */
  const say = async (text: string, opts: { followUp?: boolean } = {}) => {
    let out = "";
    const t0 = Date.now();
    const patient = state.patient && opts.followUp === true;
    state.ended = false;
    state.patient = false;
    const ctx = {
      deviceId: "eval",
      householdId: "home",
      now,
      endConversation: () => (state.ended = true),
      listenPatiently: () => (state.patient = true),
    };
    const notes = [...(opts.followUp ? [FOLLOW_UP_NOTE] : []), ...(patient ? [PATIENT_NOTE] : [])];
    const systemNotes = notes.length ? notes : undefined;
    for await (const s of o.respond({ history, userText: text, ctx, systemNotes })) {
      if (!out) firstSentenceMs.push(Date.now() - t0);
      out += s;
    }
    return out;
  };
  return {
    db,
    shopping,
    reminders,
    say,
    history,
    firstSentenceMs,
    sent,
    ended: () => state.ended,
    /** 直前の回で、次の聞き取りを「ゆっくり聞く」にしたか（017） */
    patient: () => state.patient,
  };
}

/** Claude Haiku に、条件を満たすかを判定させる（YES / NO） */
export async function judge(question: string, answer: string): Promise<boolean> {
  const r = await anthropic.messages.create({
    model: config.llm.model,
    max_tokens: 200,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: "あなたは評価者です。与えられた条件をアシスタントの返事が満たしていれば YES、満たしていなければ NO とだけ答えてください。",
    messages: [{ role: "user", content: `条件：${question}\n\nアシスタントの返事：${answer}` }],
  });
  const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return /YES/i.test(text);
}

/** 返事に、読み上げてはいけないもの（英語の文・タグ）が混ざっていないか */
export function leaks(answer: string): boolean {
  return /[A-Za-z]{2,}[ ,.'][A-Za-z ,.']{6,}/.test(answer) || /<\/?[a-z_]+>/.test(answer);
}

export async function repeat(name: string, times: number, fn: (i: number) => Promise<{ ok: boolean; detail: string }>) {
  let pass = 0;
  for (let i = 0; i < times; i++) {
    const r = await fn(i);
    if (r.ok) pass++;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${name} #${i + 1}: ${r.detail}`);
  }
  console.log(`== ${name}: ${pass}/${times}`);
  return pass === times;
}
