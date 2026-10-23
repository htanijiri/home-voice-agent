import { describe, expect, it } from "vitest";
import { estimateMonthlyCost } from "../src/report/cost.js";
import { openDb } from "../src/db/db.js";
import { TurnsRepo } from "../src/db/turns-repo.js";
import { buildReport, stats } from "../src/report/report.js";
import { testConfig } from "./helpers.js";

const noListen = {
  listen_audio_ms: null,
  listen_ms_to_first_audio: null,
  listen_max_gap_ms: null,
  listen_noise_rms: null,
  listen_speech_rms: null,
  listen_ms_to_speech_start: null,
  listen_ms_to_local_speech_start: null,
  listen_finals: null,
  listen_empty_final: null,
  no_speech_reason: null,
};

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
      ...noListen,
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

  it("聞き取れなかった回の内訳（009）", () => {
    const base = { id: 1, device_id: "d", created_at: "2026-11-01T00:00:00.000Z", user_text: "", assistant_text: "", error_kind: null, ms_listen_to_speech_end: null, ms_speech_end_to_stt: null, ms_stt_to_first_sentence: null, ms_first_sentence_to_audio: null, ms_total: null, ...noListen };
    const t = (outcome: string, reason: string | null, speech: number, noise: number, start: number | null) => ({
      ...base,
      outcome,
      no_speech_reason: reason,
      listen_audio_ms: 4000,
      listen_ms_to_first_audio: 100,
      listen_max_gap_ms: 80,
      listen_noise_rms: noise,
      listen_speech_rms: speech,
      listen_ms_to_speech_start: start,
      listen_finals: 1,
      listen_empty_final: outcome === "ok" ? 0 : 1,
    });
    const md = buildReport({
      month: "2026-11",
      turns: [t("ok", null, 400, 20, 900), t("no_speech", "timeout", 60, 30, null), t("no_speech", "timeout", 80, 40, null), t("no_speech", "empty", 120, 50, 1500), { ...base, outcome: "ok" }],
      usage: {},
      pricing: testConfig().pricing,
      daysInPeriod: 1,
    });
    expect(md).toContain("- 記録のある聞き取り：4 回、うち聞き取れなかった回：3 回");
    expect(md).toContain("  - 話し始めの合図が来なかった（timeout）：2 回");
    expect(md).toContain("| 声の大きさ（RMS） | 400（1） | 60（2） | 120（1） |");
    expect(md).toContain("| 話し始めの合図まで（ms） | 900（1） | - | 1500（1） |");
  });

  it("聞き取りの様子を turns に保存する（009）", () => {
    const repo = new TurnsRepo(openDb(":memory:"));
    const listen = { audioMs: 6000, msToFirstAudio: 150, maxGapMs: 90, noiseRms: 12, speechRms: 40, msToSpeechStart: null, msToLocalSpeechStart: 900, finals: 0, emptyFinal: true, noSpeechReason: "timeout" as const };
    repo.insert({ deviceId: "d", userText: "", assistantText: "x", outcome: "no_speech", timings: {}, listen }, new Date());
    repo.insert({ deviceId: "d", userText: "", assistantText: "x", outcome: "ok", timings: {} }, new Date());
    const [plain, rec] = repo.list();
    expect(rec).toMatchObject({ listen_audio_ms: 6000, listen_ms_to_first_audio: 150, listen_max_gap_ms: 90, listen_noise_rms: 12, listen_speech_rms: 40, listen_ms_to_speech_start: null, listen_ms_to_local_speech_start: 900, listen_finals: 0, listen_empty_final: 1, no_speech_reason: "timeout" });
    expect(plain).toMatchObject({ listen_audio_ms: null, no_speech_reason: null });
  });
});
