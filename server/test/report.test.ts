import { describe, expect, it } from "vitest";
import { estimateMonthlyCost } from "../src/report/cost.js";
import { buildReport, stats } from "../src/report/report.js";
import { testConfig } from "./helpers.js";

describe("集計", () => {
  it("平均・中央値・95パーセンタイル・最大", () => {
    const s = stats([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])!;
    expect(s).toEqual({ count: 10, mean: 550, median: 500, p95: 1000, max: 1000 });
    expect(stats([])).toBeUndefined();
  });

  it("費用：無料枠を引き、単価をかける", () => {
    const p = testConfig().pricing;
    const c = estimateMonthlyCost(
      { llm_input_tokens: 2_000_000, llm_output_tokens: 200_000, stt_seconds: 120 * 60, tts_chars: 1_500_000 },
      p,
    );
    expect(c.llm).toBeCloseTo(2 * 0.1 + 0.2 * 0.5);
    expect(c.stt).toBeCloseTo((120 - 60) * 0.016);
    expect(c.tts).toBeCloseTo(0.5 * 30);
    expect(c.totalJpy).toBe(Math.round((c.llm + c.stt + c.tts + p.flyMonthly) * p.usdJpy));
  });

  it("レポートに工程ごとの表と費用が入る", () => {
    const turn = (ms: number) => ({
      id: 1,
      device_id: "d",
      created_at: "2026-11-01T00:00:00.000Z",
      user_text: "x",
      assistant_text: "y",
      outcome: "ok",
      error_kind: null,
      ms_listen_to_speech_end: 2000,
      ms_speech_end_to_stt: 300,
      ms_stt_to_first_sentence: 800,
      ms_first_sentence_to_audio: 400,
      ms_total: ms,
    });
    const md = buildReport({
      month: "2026-11",
      turns: [turn(1500), turn(2500)],
      usage: { turns: 2 },
      pricing: testConfig().pricing,
      daysInPeriod: 1,
    });
    expect(md).toContain("| 話し終わり→読み上げ開始（合計） | 2 | 2000 | 1500 | 2500 | 2500 |");
    expect(md).toContain("1日あたり 2.0 回");
    expect(md).toMatch(/約 \d+ 円/);
  });
});
