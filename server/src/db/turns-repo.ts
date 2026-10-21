// 会話の記録（文字だけ）と、工程ごとの所要時間
import type { TurnRecord } from "../core/voice-session.js";
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
}

const diff = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : null);

export class TurnsRepo {
  constructor(private readonly db: Db) {}

  insert(rec: TurnRecord, now: Date): void {
    const t = rec.timings;
    this.db
      .prepare(
        `INSERT INTO turns (device_id, created_at, user_text, assistant_text, outcome, error_kind,
          ms_listen_to_speech_end, ms_speech_end_to_stt, ms_stt_to_first_sentence, ms_first_sentence_to_audio, ms_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
