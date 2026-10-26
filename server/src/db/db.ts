// SQLite の接続とマイグレーション。テーブルを足すときは MIGRATIONS の末尾に追加する（既存の要素は書き換えない）。
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  // 1: 端末、会話の記録、利用量
  `
  CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    client_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','approved')),
    activation_code TEXT,
    token_hash TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    last_seen_at TEXT,
    firmware_version TEXT
  );
  CREATE UNIQUE INDEX devices_activation_code ON devices(activation_code) WHERE activation_code IS NOT NULL;

  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error_kind TEXT,
    ms_listen_to_speech_end INTEGER,
    ms_speech_end_to_stt INTEGER,
    ms_stt_to_first_sentence INTEGER,
    ms_first_sentence_to_audio INTEGER,
    ms_total INTEGER
  );
  CREATE INDEX turns_created_at ON turns(created_at);

  CREATE TABLE usage (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    quantity REAL NOT NULL,
    PRIMARY KEY (day, kind)
  );
  `,
  // 2: 小さな状態の保存（夜間の音量の切り替えなど）
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 3: 買い物リスト
  `
  CREATE TABLE shopping_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','bought','deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    bought_at TEXT
  );
  CREATE INDEX shopping_items_household ON shopping_items(household_id, status);
  `,
  // 4: リマインダーと、通知の記録（1回の予定につき1行。attempts は読み上げた回数）
  `
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id TEXT NOT NULL,
    title TEXT NOT NULL,
    schedule TEXT NOT NULL,
    next_fire_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','done','deleted')),
    skip_next INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX reminders_due ON reminders(status, next_fire_at);

  CREATE TABLE reminder_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER NOT NULL REFERENCES reminders(id),
    title TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','sent','acknowledged','done','missed','told','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    ack_at TEXT,
    UNIQUE (reminder_id, scheduled_at)
  );
  CREATE INDEX reminder_deliveries_state ON reminder_deliveries(state);
  `,
  // 5: 確認画面のログインのセッション（Cookie にはランダムな ID だけを入れ、ここにはそのハッシュを保存する）
  `
  CREATE TABLE web_sessions (
    id_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    csrf TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
  // 6: 聞き取りの様子（009）。数字だけで、音声や文章は入れない
  `
  ALTER TABLE turns ADD COLUMN listen_audio_ms INTEGER;
  ALTER TABLE turns ADD COLUMN listen_ms_to_first_audio INTEGER;
  ALTER TABLE turns ADD COLUMN listen_max_gap_ms INTEGER;
  ALTER TABLE turns ADD COLUMN listen_noise_rms INTEGER;
  ALTER TABLE turns ADD COLUMN listen_speech_rms INTEGER;
  ALTER TABLE turns ADD COLUMN listen_ms_to_speech_start INTEGER;
  ALTER TABLE turns ADD COLUMN listen_finals INTEGER;
  ALTER TABLE turns ADD COLUMN listen_empty_final INTEGER;
  ALTER TABLE turns ADD COLUMN no_speech_reason TEXT;
  `,
  // 7: サーバーの判定で話し始めた時刻（011）
  `
  ALTER TABLE turns ADD COLUMN listen_ms_to_local_speech_start INTEGER;
  `,
  // 8: 本当の話し終わりから、最初の音声を送り始めるまで（012）
  `
  ALTER TABLE turns ADD COLUMN ms_voice_end_to_audio INTEGER;
  `,
  // 9: リマインダーをもう1回読み上げる時刻（015）
  `
  ALTER TABLE reminder_deliveries ADD COLUMN retry_at TEXT;
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
