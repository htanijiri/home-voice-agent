// 動作確認用：◯秒後の一回限りのリマインダーを、データベースに直接登録する（開発用）
//   npm run add-reminder -- 180 "再起動のテスト"（クラウドでは fly ssh console -C "node_modules/.bin/tsx src/cli/add-reminder.ts 180 テスト"）
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { dateKey, timeKey, toLocal } from "../core/reminders/zoned.js";
import { openDb } from "../db/db.js";
import { RemindersRepo } from "../db/reminders-repo.js";

const config = loadConfig();
const db = openDb(resolve(config.server.dataDir, "app.db"));
const sec = Number(process.argv[2] ?? 180);
const title = process.argv[3] ?? "テスト";
const at = new Date(Math.ceil((Date.now() + sec * 1000) / 60000) * 60000);
const l = toLocal(at, config.household.timezone);
const r = new RemindersRepo(db, config.household.timezone).create(config.household.id, title, { kind: "once", date: dateKey(l), time: timeKey(l.hh, l.mm) }, at, new Date());
console.log(`登録しました：id=${r.id} ${l.hh}:${String(l.mm).padStart(2, "0")}`);
db.close();
