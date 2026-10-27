// 家族への連絡のツール（016）。リビングから、外出中の家族などに用件を送る（確認画面に出て、スマホに通知される）。
// 保存と通知は FamilyMessenger の向こう側で行い、ここからデータベースや通知の仕組みを直接呼ばない。
import type { Tool } from "./registry.js";

export interface FamilyMessenger {
  /** 送る。1 日の上限に達していたら、理由を書いた Error を投げる */
  send(householdId: string, to: string | undefined, text: string, now: Date): Promise<void>;
}

export function messageTools(messenger: FamilyMessenger, maxChars: number): Tool[] {
  return [
    {
      reply: true,
      def: {
        name: "send_family_message",
        description:
          "リビングから家族に連絡を送る。確認画面に表示され、家族のスマホに通知が届く。「パパに連絡して」「ママに〇〇って伝えて」「お母さんに〇〇か聞いて」のときに使う。" +
          "text には伝える用件を、話した言葉のまま入れる。「って伝えて」「か聞いて」の結びだけを外して、相手にそのまま伝わる形にし、内容を言い換えたり、まとめたり、言葉を足したりしない（例：「今日何時に帰るか聞いて」→「今日何時に帰る？」）。" +
          "「パパに連絡して」のように用件がないときは、このツールを呼ばずに「なんて伝える？」と聞き返し、次の発話を用件として送る。聞き返しに「それだけ」「なんでもない」など用件がないと答えたら、text を「連絡してほしいそうです」にして送る。" +
          "to には、話した宛先の呼び方をそのまま入れる（パパ、ママ、お父さん、お母さん など）。宛先を言わなかったら省く。reply の例：「パパに送ったよ。」",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "宛先の呼び方（話したとおり）" },
            text: { type: "string", description: `伝える用件（${maxChars} 文字まで）` },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const text = String(input.text ?? "").trim();
        if (!text) throw new Error("用件が空です");
        if ([...text].length > maxChars) throw new Error(`用件が長すぎます（${maxChars} 文字まで）。短くしてもらってください`);
        const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : undefined;
        await messenger.send(ctx.householdId, to, text, ctx.now);
        return { ok: true, to: to ?? "家族" };
      },
    },
  ];
}
