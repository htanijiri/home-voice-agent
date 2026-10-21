// Anthropic（Claude）のアダプター。SDK を使うのはこのファイルだけ。
// thinking はオン（effort は low）にする。オフにすると、考えたこと（「明日ではなく金曜日なので…」や英語のメモ）を
// 返事に書いてしまい、それが読み上げられるため。
// thinking のブロックは、いまの1回の返事の中（ツールの往復）でだけ元のまま返す（providerBlocks）。前の会話の分は
// 履歴に保存するときに外すので、履歴を切り詰めても、Haiku 5.5 の履歴の検証（thinking の前が変わると 400）に当たらない。
import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel, LlmEvent, LlmRequest } from "../core/ports.js";
import type { ChatMessage, ContentBlock } from "../core/types.js";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  effort: "low" | "medium" | "high";
}

function toParam(m: ChatMessage): Anthropic.MessageParam {
  if (m.role === "assistant" && m.providerBlocks) {
    return { role: "assistant", content: m.providerBlocks as Anthropic.ContentBlockParam[] };
  }
  const content: Anthropic.ContentBlockParam[] = m.content.map((b): Anthropic.ContentBlockParam => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> };
      case "tool_result":
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
    }
  });
  return { role: m.role, content };
}

function fromMessage(msg: Anthropic.Message): ChatMessage {
  const content: ContentBlock[] = [];
  for (const b of msg.content) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  // 元のブロック（thinking の署名を含む）を、そのまま返せるように持っておく
  return { role: "assistant", content, providerBlocks: msg.content as unknown[] };
}

export class AnthropicLlm implements LanguageModel {
  private readonly client: Anthropic;
  readonly modelName: string;

  constructor(private readonly cfg: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, timeout: 30_000 });
    this.modelName = cfg.model;
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const stream = this.client.messages.stream(
      {
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: this.cfg.effort },
        // システムプロンプトとツールは固定なので、キャッシュする
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages: req.messages.map(toParam),
      },
      { signal: req.signal },
    );
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        yield { type: "text_delta", text: ev.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield {
      type: "done",
      message: fromMessage(final),
      stopReason: final.stop_reason ?? "end_turn",
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
