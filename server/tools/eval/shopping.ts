// 003 AC4：買い物リストの会話が、期待どおりに保存される
// 012 AC5：追加の返事の速さ
import { leaks, newWorld, repeat } from "./harness.js";

const names = (w: ReturnType<typeof newWorld>) => w.shopping.active("home").map((i) => i.name).sort();

const a = await repeat("追加・確認・削除・買った", 5, async () => {
  const w = newWorld();
  const log: string[] = [];
  log.push(await w.say("牛乳を買い物リストに入れて"));
  log.push(await w.say("卵とパンも入れて"));
  log.push(await w.say("何が入ってる？"));
  const afterAdd = names(w).join(",");
  log.push(await w.say("牛乳を削除して"));
  log.push(await w.say("卵は買ったよ"));
  const final = names(w);
  const ok = !log.some(leaks) && afterAdd.includes("牛乳") && afterAdd.includes("卵") && /パン/.test(afterAdd) && final.length === 1 && /パン/.test(final[0]!);
  return { ok, detail: `after add=[${afterAdd}] final=[${final.join(",")}] / ${log.join(" | ")}` };
});

const b = await repeat("表記ゆれを重複させない", 10, async () => {
  const w = newWorld();
  await w.say("卵を買い物リストに入れて");
  const answer = await w.say("たまごを入れて");
  const ok = w.shopping.active("home").length === 1 && !leaks(answer);
  return { ok, detail: `[${w.firstSentenceMs}ms] list=[${names(w).join(",")}] / ${answer}` };
});
const c = await repeat("関係のない質問で買い物リストの話をしない", 5, async () => {
  const w = newWorld();
  w.shopping.add("home", "洗剤", undefined, new Date());
  w.shopping.add("home", "食パン", undefined, new Date());
  const answer = await w.say("日本で一番高い山は？");
  const ok = !leaks(answer) && /富士山/.test(answer) && !/買い物|洗剤|食パン/.test(answer);
  return { ok, detail: answer };
});
// 012 AC5：追加の返事の、最初の文までの時間（中央値を改善前と比べる）
const addMs: number[] = [];
const d = await repeat("追加の速さ", 10, async () => {
  const w = newWorld();
  const answer = await w.say("牛乳を買い物リストに入れて");
  addMs.push(w.firstSentenceMs[0]!);
  const ok = !leaks(answer) && names(w).join(",") === "牛乳";
  return { ok, detail: `[${w.firstSentenceMs[0]}ms] ${answer}` };
});
const sorted = [...addMs].sort((x, y) => x - y);
console.log(`== 追加の最初の文まで：中央値 ${sorted[Math.floor(sorted.length / 2)]}ms（${sorted.join(", ")}）`);
process.exit(a && b && c && d ? 0 : 1);
