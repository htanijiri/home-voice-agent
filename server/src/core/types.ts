// 会話のコアで使う型。外部サービスの SDK の型に依存しない。

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
  /**
   * 外部サービスの返した元のブロック（thinking のブロックなど）。いまの1回の返事の中（ツールの往復）でだけ使い、
   * 会話の履歴に保存するときには外す（会話のコアはこの中身を見ない）
   */
  providerBlocks?: unknown[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（object） */
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
