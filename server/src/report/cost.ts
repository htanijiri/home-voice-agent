// 利用量と単価から、費用の目安（米ドル・円）を計算する
export interface Pricing {
  llmInputPerMTok: number;
  llmOutputPerMTok: number;
  llmCacheReadPerMTok: number;
  llmCacheWritePerMTok: number;
  sttPerMinute: number;
  sttFreeMinutesPerMonth: number;
  ttsPerMChars: number;
  ttsFreeCharsPerMonth: number;
  flyMonthly: number;
  usdJpy: number;
}

export interface CostBreakdown {
  llm: number;
  stt: number;
  tts: number;
  server: number;
  totalUsd: number;
  totalJpy: number;
}

/** usage：月の合計（UsageRepo.sumByPrefix の結果） */
export function estimateMonthlyCost(usage: Record<string, number>, p: Pricing): CostBreakdown {
  const q = (k: string) => usage[k] ?? 0;
  const llm =
    (q("llm_input_tokens") * p.llmInputPerMTok +
      q("llm_output_tokens") * p.llmOutputPerMTok +
      q("llm_cache_read_tokens") * p.llmCacheReadPerMTok +
      q("llm_cache_write_tokens") * p.llmCacheWritePerMTok) /
    1_000_000;
  const sttMinutes = q("stt_seconds") / 60;
  const stt = Math.max(0, sttMinutes - p.sttFreeMinutesPerMonth) * p.sttPerMinute;
  const tts = (Math.max(0, q("tts_chars") - p.ttsFreeCharsPerMonth) * p.ttsPerMChars) / 1_000_000;
  const server = p.flyMonthly;
  const totalUsd = llm + stt + tts + server;
  return { llm, stt, tts, server, totalUsd, totalJpy: Math.round(totalUsd * p.usdJpy) };
}
