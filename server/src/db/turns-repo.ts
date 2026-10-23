// 会話の記録（文字だけ）と、工程ごとの所要時間
import type { TurnRecord, TurnTimings } from "../core/voice-session.js";
import type { Db } from "./db.js";

export interface TurnRow {
  id: number;
  device_id: string;
  created_at: string;
  user_text: string;
  assistant_text: string;
  outcome: string;
  error_kind: string | null;
  ms_listen_to_speech_end: number | null;
  ms_speech_end_to_stt: number | null;
  ms_stt_to_first_sentence: number | null;
  ms_first_sentence_to_audio: number | null;
  ms_total: number | null;
  ms_voice_end_to_audio: number | null;
  listen_audio_ms: number | null;
  listen_ms_to_first_audio: number | null;
  listen_max_gap_ms: number | null;
  listen_noise_rms: number | null;
  listen_speech_rms: number | null;
  listen_ms_to_speech_start: number | null;
  listen_ms_to_local_speech_start: number | null;
  listen_finals: number | null;
  listen_empty_final: number | null;
  no_speech_reason: string | null;
}

const diff = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : null);

/** 本当の話し終わり（なければ STT の話し終わりの合図）から、最初の音声を送り始める（tts start）まで。端末側の待ちは含まない */
export const voiceEndToAudio = (t: TurnTimings) => diff(t.voiceEndAt ?? t.speechEndAt, t.firstAudioAt);

export class TurnsRepo {
  constructor(private readonly db: Db) {}

  insert(rec: TurnRecord, now: Date): void {
    const t = rec.timings;
    const l = rec.listen;
    this.db
      .prepare(
        `INSERT INTO turns (device_id, created_at, user_text, assistant_text, outcome, error_kind,
          ms_listen_to_speech_end, ms_speech_end_to_stt, ms_stt_to_first_sentence, ms_first_sentence_to_audio, ms_total, ms_voice_end_to_audio,
          listen_audio_ms, listen_ms_to_first_audio, listen_max_gap_ms, listen_noise_rms, listen_speech_rms,
          listen_ms_to_speech_start, listen_ms_to_local_speech_start, listen_finals, listen_empty_final, no_speech_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.deviceId,
        now.toISOString(),
        rec.userText,
        rec.assistantText,
        rec.outcome,
        rec.errorKind ?? null,
        diff(t.listenStartAt, t.speechEndAt),
        diff(t.speechEndAt, t.sttFinalAt),
        diff(t.sttFinalAt, t.firstSentenceAt),
        diff(t.firstSentenceAt, t.firstAudioAt),
        diff(t.speechEndAt ?? t.listenStartAt, t.firstAudioAt),
        voiceEndToAudio(t),
        l?.audioMs ?? null,
        l?.msToFirstAudio ?? null,
        l?.maxGapMs ?? null,
        l?.noiseRms ?? null,
        l?.speechRms ?? null,
        l?.msToSpeechStart ?? null,
        l?.msToLocalSpeechStart ?? null,
        l?.finals ?? null,
        l ? Number(l.emptyFinal) : null,
        l?.noSpeechReason ?? null,
      );
  }

  list(opts: { since?: Date; limit?: number } = {}): TurnRow[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE created_at >= ? ORDER BY id DESC LIMIT ?")
      .all(opts.since?.toISOString() ?? "", opts.limit ?? 1000) as TurnRow[];
  }

  /** 保存期間を過ぎたものを消す。消した件数を返す */
  deleteOlderThan(cutoff: Date): number {
    return this.db.prepare("DELETE FROM turns WHERE created_at < ?").run(cutoff.toISOString()).changes;
  }

  deleteAll(): number {
    return this.db.prepare("DELETE FROM turns").run().changes;
  }
}
