// 端末の音量を、サーバーから指定する（運用のコマンド）。つながっている端末には1分以内に、つながっていなければ次につながったときに設定する。
//   npm run set-volume -- 60
//   クラウド：fly ssh console -C "node_modules/.bin/tsx src/cli/set-volume.ts 60"
import { resolve } from "node:path";
import { VolumePolicy } from "../app/volume-policy.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/db.js";
import { KvRepo } from "../db/kv-repo.js";

const config = loadConfig();
const db = openDb(resolve(config.server.dataDir, "app.db"));
const v = Number(process.argv[2]);
if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error("音量は 0〜100");
new VolumePolicy(config.volume, config.household.timezone, new KvRepo(db)).request(v);
console.log(`音量 ${v} を指定しました（端末に1分以内に反映されます）`);
db.close();
