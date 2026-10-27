// LLM に渡すツールの登録と実行。入力は JSON Schema の必須項目と型だけをここで確かめ、細かい検証は各ツールで行う。
import type { ToolDefinition } from "../types.js";

/** 端末を操作する手段（音量など）。通信方式ごとに実装する */
export interface DeviceControl {
  setVolume(volume: number): Promise<void>;
  getVolume(): Promise<number | undefined>;
}

export interface ToolContext {
  deviceId: string;
  householdId: string;
  now: Date;
  device?: DeviceControl;
  /** 会話を終えて、続けての聞き取りをせずに待機に戻る（013） */
  endConversation?: () => void;
  /** 次の1回の聞き取りを、話し始めと途中の無言を長めに待つ「ゆっくり聞く」にする（017） */
  listenPatiently?: () => void;
}

export interface Tool {
  def: ToolDefinition;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /**
   * 入力に reply（うまくいったら言う言葉）を受け付ける操作のツール（012）。
   * 結果が思ったとおりなら、2回目の LLM の呼び出しをせずに reply を読み上げる。
   * 思ったとおりでない結果（既にあった、など）は、run の戻り値に expected: false を入れて知らせる
   */
  reply?: boolean;
  /** reply がないときは、結果を LLM に返さずにその回を終えてよい（013：end_conversation） */
  terminal?: boolean;
}

/** reply の説明。操作のツールの入力に足す */
export const REPLY_PROP = {
  type: "string",
  description:
    "操作がうまくいったときに、そのまま読み上げる返事（1〜2文の短い話し言葉）。例：「牛乳を買い物リストに追加しました。」。件数や残りの品目、既にあったかどうかなど、結果を見ないと分からないことは書かない。思ったとおりにいかなかったときは使われず、結果を見て改めて返事を作る。",
};

export interface ToolRunResult {
  content: string;
  isError: boolean;
  /** うまくいき、結果が思ったとおりだった（reply をそのまま使ってよい） */
  expected: boolean;
}

export class ToolInputError extends Error {}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(...tools: Tool[]): this {
    for (const t of tools) this.tools.set(t.def.name, t);
    return this;
  }

  /** 名前順に並べて返す（プロンプトのキャッシュが効くよう順序を固定する） */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .map((t) => (t.reply ? withReply(t.def) : t.def))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** reply がなければ、結果を LLM に返さずに終えてよいツールか */
  isTerminal(name: string): boolean {
    return this.tools.get(name)?.terminal === true;
  }

  /** reply を受け付けるツールか */
  acceptsReply(name: string): boolean {
    return this.tools.get(name)?.reply === true;
  }

  async run(name: string, input: unknown, ctx: ToolContext): Promise<ToolRunResult> {
    const tool = this.tools.get(name);
    if (!tool) return { content: JSON.stringify({ error: `unknown tool: ${name}` }), isError: true, expected: false };
    try {
      const obj = validateInput(tool.def.inputSchema, input);
      const { reply: _reply, ...args } = obj;
      const result = await tool.run(tool.reply ? args : obj, ctx);
      let expected = true;
      let body: unknown = result ?? { ok: true };
      if (body && typeof body === "object" && "expected" in body) {
        const { expected: e, ...rest } = body as Record<string, unknown>;
        expected = e !== false;
        body = rest;
      }
      return { content: JSON.stringify(body), isError: false, expected };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: JSON.stringify({ error: message }), isError: true, expected: false };
    }
  }
}

function withReply(def: ToolDefinition): ToolDefinition {
  const schema = def.inputSchema as { properties?: Record<string, unknown> };
  return { ...def, inputSchema: { ...def.inputSchema, properties: { ...schema.properties, reply: REPLY_PROP } } };
}

function validateInput(schema: Record<string, unknown>, input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }
  const obj = input as Record<string, unknown>;
  const required = (schema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (!(key in obj)) throw new ToolInputError(`missing required field: ${key}`);
  }
  const props = (schema.properties as Record<string, { type?: string }> | undefined) ?? {};
  for (const [key, value] of Object.entries(obj)) {
    const t = props[key]?.type;
    if (!t || value === null || value === undefined) continue;
    const ok =
      t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) : typeof value === t;
    if (!ok) throw new ToolInputError(`field ${key} must be ${t}`);
  }
  return obj;
}
