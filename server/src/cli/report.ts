// 試用のレポートを Markdown で出す。
//   npm run report -- --month 2026-11 [--out ../docs/reports/2026-11.md]
//   クラウド：fly ssh console -C "node_modules/.bin/tsx src/cli/report.ts --month 2026-11"
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { localDateString } from "../core/time.js";
import { openDb } from "../db/db.js";
import { TurnsRepo } from "../db/turns-repo.js";
import { UsageRepo } from "../db/usage-repo.js";
import { buildReport } from "../report/report.js";

const { values } = parseArgs({ options: { month: { type: "string" }, out: { type: "string" } } });
const config = loadConfig();
const month = values.month ?? localDateString(new Date()).slice(0, 7);
const db = openDb(resolve(config.server.dataDir, "app.db"));
const tz = config.household.timezone;
const turns = new TurnsRepo(db).list({ limit: 100_000 }).filter((t) => localDateString(new Date(t.created_at), tz).startsWith(month));
const usage = new UsageRepo(db, tz).sumByPrefix(month);
const days = new Set(turns.map((t) => localDateString(new Date(t.created_at), tz))).size;
const md = buildReport({ month, turns, usage, pricing: config.pricing, daysInPeriod: days });
if (values.out) writeFileSync(values.out, md);
else process.stdout.write(md);
db.close();
