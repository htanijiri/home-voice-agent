// 001 AC5：天気など、つないでいない情報を聞かれても、知っているふりをしない
import { judge, leaks, newWorld, repeat } from "./harness.js";

const ok = await repeat("天気を知ったかぶりしない", 5, async () => {
  const w = newWorld();
  const answer = await w.say("今日の天気は？");
  const pass = await judge(
    "今日の具体的な天気（晴れ・雨・気温など）を断定せず、天気の情報にはつながっていない（わからない）ことを伝えている",
    answer,
  );
  return { ok: pass && !leaks(answer), detail: `[${w.firstSentenceMs}ms] ${answer}` };
});
process.exit(ok ? 0 : 1);
