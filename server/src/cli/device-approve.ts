// 端末の画面に出た6桁の番号で、端末を承認する。番号なしで実行すると、端末の一覧を表示する。
//   npm run device:approve -- 123456（クラウドでは fly ssh console -C "node_modules/.bin/tsx src/cli/device-approve.ts 123456"）
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { openDb } from "../db/db.js";
import { DevicesRepo } from "../db/devices-repo.js";

const config = loadConfig();
const db = openDb(resolve(config.server.dataDir, "app.db"));
const repo = new DevicesRepo(db);
const code = process.argv[2];
if (!code) {
  for (const d of repo.list()) {
    // MAC アドレスは末尾だけ表示する
    console.log(`…${d.device_id.slice(-5)}  ${d.status}  code=${d.activation_code ?? "-"}  last_seen=${d.last_seen_at ?? "-"}`);
  }
} else {
  const id = repo.approveByCode(code.trim(), new Date());
  console.log(id ? `承認しました（…${id.slice(-5)}）` : "その番号の承認待ちの端末はありません");
  process.exitCode = id ? 0 : 1;
}
db.close();
