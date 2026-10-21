// 試用の測定：工程ごとの待ち時間の集計、1日あたりの回数、推定費用をまとめる
import type { TurnRow } from "../db/turns-repo.js";
import { estimateMonthlyCost, type Pricing } from "./cost.js";

export interface Stats {
  count: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
}

export function stats(values: number[]): Stats | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const q = (p: number) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]!;
  return {
    count: v.length,
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
    median: q(0.5),
    p95: q(0.95),
    max: v[v.length - 1]!,
  };
}

export const STAGES = [
  ["ms_listen_to_speech_end", "聞き取り開始→話し終わり"],
  ["ms_speech_end_to_stt", "話し終わり→認識結果"],
  ["ms_stt_to_first_sentence", "認識結果→返事の最初の文"],
  ["ms_first_sentence_to_audio", "最初の文→読み上げ開始"],
  ["ms_total", "話し終わり→読み上げ開始（合計）"],
] as const;

export function buildReport(opts: {
  month: string;
  turns: TurnRow[];
  usage: Record<string, number>;
  pricing: Pricing;
  daysInPeriod: number;
}): string {
  const lines: string[] = [];
  lines.push(`# 試用のレポート（${opts.month}）`, "");
  const ok = opts.turns.filter((t) => t.outcome === "ok");
  const byOutcome = new Map<string, number>();
  for (const t of opts.turns) byOutcome.set(t.outcome, (byOutcome.get(t.outcome) ?? 0) + 1);
  lines.push("## 会話の回数", "");
  lines.push(`- 合計：${opts.turns.length} 回（1日あたり ${(opts.turns.length / Math.max(1, opts.daysInPeriod)).toFixed(1)} 回）`);
  for (const [k, v] of byOutcome) lines.push(`- ${k}：${v} 回`);
  lines.push("", "## 待ち時間（ミリ秒、うまくいった会話のみ）", "");
  lines.push("| 工程 | 件数 | 平均 | 中央値 | 95% | 最大 |", "|---|---|---|---|---|---|");
  for (const [key, label] of STAGES) {
    const s = stats(ok.map((t) => t[key] as number | null).filter((x): x is number => x !== null));
    lines.push(s ? `| ${label} | ${s.count} | ${s.mean} | ${s.median} | ${s.p95} | ${s.max} |` : `| ${label} | 0 | - | - | - | - |`);
  }
  const slow = [...ok].filter((t) => t.ms_total !== null).sort((a, b) => b.ms_total! - a.ms_total!).slice(0, 5);
  if (slow.length) {
    lines.push("", "### 遅かった会話（上位5件）", "");
    for (const t of slow) lines.push(`- ${t.created_at}：${t.ms_total}ms（認識 ${t.ms_speech_end_to_stt ?? "-"}ms / 返事 ${t.ms_stt_to_first_sentence ?? "-"}ms / 読み上げ ${t.ms_first_sentence_to_audio ?? "-"}ms）`);
  }
  const c = estimateMonthlyCost(opts.usage, opts.pricing);
  const u = (k: string) => Math.round(opts.usage[k] ?? 0);
  lines.push("", "## 利用量と推定費用", "");
  lines.push("| 項目 | 利用量 | 推定（米ドル） |", "|---|---|---|");
  lines.push(`| Claude | 入力 ${u("llm_input_tokens")} / 出力 ${u("llm_output_tokens")} トークン | ${c.llm.toFixed(2)} |`);
  lines.push(`| 音声認識 | ${(u("stt_seconds") / 60).toFixed(1)} 分 | ${c.stt.toFixed(2)} |`);
  lines.push(`| 読み上げ | ${u("tts_chars")} 文字 | ${c.tts.toFixed(2)} |`);
  lines.push(`| サーバー（Fly.io、固定） | - | ${c.server.toFixed(2)} |`);
  lines.push(`| **合計** | | **${c.totalUsd.toFixed(2)}（約 ${c.totalJpy} 円）** |`);
  lines.push("", "単価は config.toml の [pricing]（確認日はコメントを参照）。実際の請求は各社の画面で確かめる。");
  return lines.join("\n") + "\n";
}
