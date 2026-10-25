// 会話を終えるツール（013）。「もういいよ」「ばいばい」や、アイリスへの話しかけでない声のときに使う。
import type { Tool } from "./registry.js";

export function conversationTools(): Tool[] {
  return [
    {
      reply: true,
      // reply がなければ、結果を LLM に返さずに黙って終える
      terminal: true,
      def: {
        name: "end_conversation",
        description:
          "会話を終えて待機に戻る。ユーザーが「もういいよ」「ばいばい」「おしまい」「ありがとう、大丈夫」など会話を終えたいときは、reply に短いあいさつ（例：「はい、またね。」）を入れて呼ぶ。頼みごとが一緒にあれば（「もういいよ、牛乳も入れといて」など）、頼みごとのツールとこのツールを必ず同じ回に呼ぶ。続けての聞き取りで、アイリスへの話しかけでない声（家族どうしの会話、テレビなど）を拾ったときは、reply を入れずに呼ぶ（何も言わずに待機に戻る）。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async run(_input, ctx) {
        ctx.endConversation?.();
        return { ok: true };
      },
    },
  ];
}
