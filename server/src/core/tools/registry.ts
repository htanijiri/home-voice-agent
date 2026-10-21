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
}

export interface Tool {
  def: ToolDefinition;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
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
    return [...this.tools.values()].map((t) => t.def).sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(name: string, input: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) return { content: JSON.stringify({ error: `unknown tool: ${name}` }), isError: true };
    try {
      const obj = validateInput(tool.def.inputSchema, input);
      const result = await tool.run(obj, ctx);
      return { content: JSON.stringify(result ?? { ok: true }), isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: JSON.stringify({ error: message }), isError: true };
    }
  }
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
