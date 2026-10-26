// 確認画面の HTML。ビルドの工程を持たないよう、CSS と JavaScript もここに書く。
// 画面に出す文字は textContent で入れ、HTML として解釈させない。

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { --bg:#f6f5f2; --card:#fff; --text:#222; --muted:#6b6b6b; --line:#e3e0da; --accent:#2f6f5e; --danger:#b3412f; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161716; --card:#202221; --text:#ecebe8; --muted:#a3a29e; --line:#353734; --accent:#6fc2a8; --danger:#ff8a75; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin:0; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background:var(--bg); color:var(--text); font-size:16px; line-height:1.5; }
header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 16px 0; z-index:1; }
header h1 { font-size:18px; margin:0 0 8px; }
nav { display:flex; gap:4px; overflow-x:auto; }
nav button { flex:1; border:0; background:none; padding:10px 8px; font-size:15px; color:var(--muted); border-bottom:3px solid transparent; cursor:pointer; white-space:nowrap; }
nav button[aria-selected=true] { color:var(--text); border-color:var(--accent); font-weight:600; }
main { padding:16px; max-width:640px; margin:0 auto; }
section[hidden] { display:none; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:12px; }
h2 { font-size:15px; color:var(--muted); margin:20px 0 8px; font-weight:600; }
ul.list { list-style:none; margin:0; padding:0; }
ul.list li { display:flex; align-items:center; gap:8px; padding:10px 0; border-bottom:1px solid var(--line); }
ul.list li.stack { flex-wrap:wrap; }
ul.list li.stack > .grow { flex:1 1 100%; }
ul.list li.stack > button { margin-left:-6px; }
ul.list li:last-child { border-bottom:0; }
.grow { flex:1; min-width:0; overflow-wrap:anywhere; }
.sub { color:var(--muted); font-size:13px; }
.empty { color:var(--muted); padding:8px 0; }
form.row { display:flex; gap:8px; flex-wrap:wrap; }
textarea { width:100%; resize:vertical; font-family:inherit; }
input, select, textarea { font-size:16px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); min-width:0; }
input.grow { flex:1 1 140px; }
button.btn { font-size:15px; padding:8px 12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--danger); }
button.icon { border:0; background:none; font-size:14px; color:var(--muted); padding:6px; cursor:pointer; }
input[type=checkbox] { width:22px; height:22px; accent-color:var(--accent); }
.days { display:flex; gap:6px; flex-wrap:wrap; }
.days label { display:flex; align-items:center; gap:2px; font-size:14px; }
.field { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
.field > span { font-size:13px; color:var(--muted); }
#toast { position:fixed; left:16px; right:16px; bottom:16px; margin:auto; max-width:480px; background:var(--text); color:var(--bg); padding:10px 14px; border-radius:10px; opacity:0; transition:opacity .2s; pointer-events:none; }
#toast.show { opacity:.92; }
table { width:100%; border-collapse:collapse; font-size:14px; }
td { padding:6px 0; border-bottom:1px solid var(--line); }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
`;

export function renderLoginPage(message?: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>アイリス</title><style>${STYLE}</style></head><body><main>
<div class="card" style="margin-top:20vh;text-align:center">
<h1 style="font-size:20px">アイリスの確認画面</h1>
<p class="sub">買い物リストとリマインダーを見たり直したりできます</p>
${message ? `<p style="color:var(--danger)">${esc(message)}</p>` : ""}
<p><a class="btn primary" style="display:inline-block;text-decoration:none;padding:10px 16px;border-radius:8px;background:var(--accent);color:#fff" href="/auth/start">Google でログイン</a></p>
</div></main></body></html>`;
}

export function renderAppPage(email: string, csrf: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf" content="${esc(csrf)}"><title>アイリス</title><style>${STYLE}</style></head><body>
<header><h1>アイリス</h1><nav role="tablist">
<button role="tab" data-tab="shopping" aria-selected="true">買い物</button>
<button role="tab" data-tab="reminders" aria-selected="false">リマインダー</button>
<button role="tab" data-tab="announce" aria-selected="false">話す</button>
<button role="tab" data-tab="more" aria-selected="false">その他</button>
</nav></header>
<main>
<section id="tab-shopping">
  <form class="row card" id="shop-add"><input class="grow" name="name" placeholder="品名（例：牛乳）" required maxlength="60"><input name="note" placeholder="メモ（2本など）" style="flex:0 1 120px" maxlength="40"><button class="btn primary">追加</button></form>
  <div class="card"><ul class="list" id="shop-list"></ul></div>
  <h2>最近買ったもの（7日間）</h2>
  <div class="card"><ul class="list" id="shop-recent"></ul></div>
</section>
<section id="tab-reminders" hidden>
  <div class="card"><ul class="list" id="rem-list"></ul></div>
  <h2>リマインダーを追加・変更</h2>
  <form class="card" id="rem-form">
    <input type="hidden" name="id">
    <label class="field"><span>内容</span><input name="title" required maxlength="60" placeholder="例：ゴミ出し"></label>
    <label class="field"><span>くり返し</span><select name="kind">
      <option value="once">一回だけ</option><option value="daily">毎日</option><option value="weekdays">平日</option>
      <option value="weekly">毎週</option><option value="monthly_day">毎月◯日</option><option value="monthly_nth">毎月第◯◯曜日</option>
    </select></label>
    <label class="field" data-for="once"><span>日付</span><input type="date" name="date"></label>
    <div class="field" data-for="weekly"><span>曜日</span><div class="days" id="weekly-days"></div></div>
    <label class="field" data-for="monthly_day"><span>日</span><input type="number" name="day" min="1" max="31" value="1"></label>
    <div class="field" data-for="monthly_nth"><span>第◯週</span><div class="days" id="nths"></div></div>
    <label class="field" data-for="monthly_nth"><span>曜日</span><select name="nthWeekday"></select></label>
    <label class="field"><span>時刻</span><input type="time" name="time" required value="08:00"></label>
    <div class="row" style="display:flex;gap:8px"><button class="btn primary">保存</button><button class="btn" type="button" id="rem-cancel" hidden>やめる</button></div>
  </form>
  <h2>お知らせできなかったもの（7日間）</h2>
  <div class="card"><ul class="list" id="rem-missed"></ul></div>
</section>
<section id="tab-announce" hidden>
  <form class="card" id="announce-form">
    <label class="field"><span>アイリスに読み上げてもらう文章（チャイムのあとに読み上げます）</span><textarea name="text" rows="3" maxlength="100" required placeholder="例：もうすぐ帰るよ"></textarea></label>
    <div class="row" style="display:flex;gap:8px;align-items:center"><button class="btn primary" id="announce-send">読み上げる</button><span class="sub" id="announce-count">あと 100 文字</span></div>
  </form>
  <p class="sub">アイリスが会話中のときは、会話が終わってから読み上げます（2分まで待ちます）。送った文章は保存しません。</p>
</section>
<section id="tab-more" hidden>
  <h2>端末</h2>
  <div class="card"><ul class="list" id="dev-list"></ul>
  <form class="row" id="dev-approve" style="margin-top:8px"><input class="grow" name="code" inputmode="numeric" pattern="\\d{6}" placeholder="端末に出た6桁の番号" required><button class="btn primary">承認</button></form></div>
  <h2>今月の利用量</h2>
  <div class="card"><table id="usage"></table></div>
  <h2>会話の記録（30日間）</h2>
  <div class="card"><ul class="list" id="conv-list"></ul><p><button class="btn danger" id="conv-delete">会話の記録をすべて消す</button></p></div>
  <p class="sub">${esc(email)} でログイン中 <button class="icon" id="logout">ログアウト</button></p>
</section>
</main><div id="toast" role="status"></div>
<script>
const CSRF = document.querySelector('meta[name=csrf]').content;
const WD = ['日','月','火','水','木','金','土'];
const $ = (s) => document.querySelector(s);
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of children) e.append(c);
  return e;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2500); }
async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login'; throw new Error('login'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || '保存できませんでした'); throw new Error(data.error); }
  return data;
}
// タブ
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('main section').forEach((s) => (s.hidden = s.id !== 'tab-' + b.dataset.tab));
  load(b.dataset.tab);
}));
// 買い物リスト
async function loadShopping() {
  const d = await api('GET', '/shopping');
  const list = $('#shop-list'); list.replaceChildren();
  if (!d.active.length) list.append(el('li', { class: 'empty', text: 'リストは空です' }));
  for (const i of d.active) {
    const cb = el('input', { type: 'checkbox', 'aria-label': i.name + 'を買った', onchange: async () => { await api('POST', '/shopping/' + i.id + '/bought'); loadShopping(); } });
    const name = el('div', { class: 'grow' }, el('div', { text: i.name }), i.note ? el('div', { class: 'sub', text: i.note }) : '');
    const edit = el('button', { class: 'icon', text: '直す', onclick: async () => {
      const n = prompt('品名', i.name); if (n === null) return;
      const note = prompt('メモ', i.note || ''); if (note === null) return;
      await api('PATCH', '/shopping/' + i.id, { name: n, note }); loadShopping();
    } });
    const del = el('button', { class: 'icon', text: '削除', onclick: async () => { if (confirm(i.name + ' を削除しますか？')) { await api('DELETE', '/shopping/' + i.id); loadShopping(); } } });
    list.append(el('li', {}, cb, name, edit, del));
  }
  const recent = $('#shop-recent'); recent.replaceChildren();
  if (!d.recent.length) recent.append(el('li', { class: 'empty', text: 'ありません' }));
  for (const i of d.recent) recent.append(el('li', {}, el('div', { class: 'grow', text: i.name }), el('button', { class: 'icon', text: 'リストに戻す', onclick: async () => { await api('POST', '/shopping/' + i.id + '/restore'); loadShopping(); } })));
}
$('#shop-add').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target;
  const r = await api('POST', '/shopping', { name: f.name.value, note: f.note.value });
  if (r.existed) toast(r.item.name + ' はもう入っています');
  f.reset(); loadShopping();
});
// リマインダー
const form = $('#rem-form');
for (let w = 0; w < 7; w++) $('#weekly-days').append(el('label', {}, el('input', { type: 'checkbox', name: 'wd', value: String(w) }), WD[w]));
for (const n of [1, 2, 3, 4, 5, -1]) $('#nths').append(el('label', {}, el('input', { type: 'checkbox', name: 'nth', value: String(n) }), n === -1 ? '最終' : '第' + n));
for (let w = 0; w < 7; w++) form.nthWeekday.append(el('option', { value: String(w), text: WD[w] + '曜日' }));
function syncKind() { document.querySelectorAll('[data-for]').forEach((x) => (x.hidden = x.dataset.for !== form.kind.value)); }
form.kind.addEventListener('change', syncKind); syncKind();
function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
form.date.value = today();
function resetForm() { form.reset(); form.id.value = ''; form.date.value = today(); $('#rem-cancel').hidden = true; syncKind(); }
$('#rem-cancel').addEventListener('click', resetForm);
function scheduleFromForm() {
  const kind = form.kind.value, time = form.time.value;
  const checked = (name) => [...form.querySelectorAll('input[name=' + name + ']:checked')].map((x) => Number(x.value));
  if (kind === 'once') return { kind, date: form.date.value, time };
  if (kind === 'weekly') return { kind, weekdays: checked('wd'), time };
  if (kind === 'monthly_day') return { kind, day: Number(form.day.value), time };
  if (kind === 'monthly_nth') return { kind, nths: checked('nth'), weekday: Number(form.nthWeekday.value), time };
  return { kind, time };
}
function fillForm(r) {
  resetForm(); form.id.value = r.id; form.title.value = r.title; const s = r.schedule;
  form.kind.value = s.kind; form.time.value = s.time;
  if (s.date) form.date.value = s.date; if (s.day) form.day.value = s.day;
  if (s.weekdays) form.querySelectorAll('input[name=wd]').forEach((x) => (x.checked = s.weekdays.includes(Number(x.value))));
  if (s.nths) form.querySelectorAll('input[name=nth]').forEach((x) => (x.checked = s.nths.includes(Number(x.value))));
  if (s.weekday !== undefined) form.nthWeekday.value = String(s.weekday);
  $('#rem-cancel').hidden = false; syncKind(); form.scrollIntoView({ behavior: 'smooth' });
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { title: form.title.value, schedule: scheduleFromForm() };
  const r = form.id.value ? await api('PATCH', '/reminders/' + form.id.value, body) : await api('POST', '/reminders', body);
  toast((r.next || r.when) + ' にお知らせします'); resetForm(); loadReminders();
});
async function loadReminders() {
  const d = await api('GET', '/reminders');
  const list = $('#rem-list'); list.replaceChildren();
  if (!d.reminders.length) list.append(el('li', { class: 'empty', text: 'リマインダーはありません' }));
  for (const r of d.reminders) {
    const info = el('div', { class: 'grow' }, el('div', { text: r.title }), el('div', { class: 'sub', text: r.when + (r.schedule.kind !== 'once' && r.next ? '（次は ' + r.next + (r.skipNext ? '・休み' : '') + '）' : '') }));
    const acts = [el('button', { class: 'icon', text: '直す', onclick: () => fillForm(r) })];
    if (r.schedule.kind !== 'once') acts.push(el('button', { class: 'icon', text: r.skipNext ? '休みをやめる' : '次だけ休む', onclick: async () => { await api('POST', '/reminders/' + r.id + '/skip-next', { skip: !r.skipNext }); loadReminders(); } }));
    acts.push(el('button', { class: 'icon', text: '削除', onclick: async () => { if (confirm(r.title + ' を削除しますか？')) { await api('DELETE', '/reminders/' + r.id); loadReminders(); } } }));
    list.append(el('li', { class: 'stack' }, info, ...acts));
  }
  const missed = $('#rem-missed'); missed.replaceChildren();
  if (!d.missed.length) missed.append(el('li', { class: 'empty', text: 'ありません' }));
  for (const m of d.missed) missed.append(el('li', {}, el('div', { class: 'grow', text: m.title }), el('div', { class: 'sub', text: m.at })));
}
// その他
async function loadMore() {
  const [dev, usage, conv] = await Promise.all([api('GET', '/devices'), api('GET', '/usage'), api('GET', '/conversations')]);
  const dl = $('#dev-list'); dl.replaceChildren();
  if (!dev.devices.length) dl.append(el('li', { class: 'empty', text: '端末はまだありません' }));
  for (const d of dev.devices) dl.append(el('li', {}, el('div', { class: 'grow' }, el('div', { text: '端末 ' + d.id + (d.status === 'pending' ? '（承認待ち）' : '') }), el('div', { class: 'sub', text: '最後の接続：' + (d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('ja-JP') : 'なし') }))));
  const u = usage.usage, c = usage.cost, t = $('#usage'); t.replaceChildren();
  const rows = [['会話の回数', (u.turns || 0) + ' 回'], ['音声認識', Math.round((u.stt_seconds || 0) / 60) + ' 分'], ['読み上げ', (u.tts_chars || 0).toLocaleString() + ' 文字'], ['費用の目安（サーバー代込み）', '約 ' + c.totalJpy.toLocaleString() + ' 円']];
  for (const [k, v] of rows) t.append(el('tr', {}, el('td', { text: k }), el('td', { class: 'num', text: v })));
  const cl = $('#conv-list'); cl.replaceChildren();
  if (!conv.turns.length) cl.append(el('li', { class: 'empty', text: '記録はありません' }));
  for (const x of conv.turns.slice(0, 100)) cl.append(el('li', {}, el('div', { class: 'grow' }, el('div', { class: 'sub', text: new Date(x.at).toLocaleString('ja-JP') }), x.user ? el('div', { text: '🗣 ' + x.user }) : '', el('div', { text: '💬 ' + x.assistant }))));
}
$('#dev-approve').addEventListener('submit', async (e) => { e.preventDefault(); await api('POST', '/devices/approve', { code: e.target.code.value }); toast('承認しました'); e.target.reset(); loadMore(); });
$('#conv-delete').addEventListener('click', async () => { if (confirm('会話の記録をすべて消しますか？元に戻せません。')) { await api('DELETE', '/conversations'); toast('消しました'); loadMore(); } });
$('#logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': CSRF } }).catch(() => {}); location.href = '/login'; });
// 確認画面から読み上げる（014）
const announceForm = $('#announce-form');
const announceCount = () => { $('#announce-count').textContent = 'あと ' + (100 - [...announceForm.text.value].length) + ' 文字'; };
announceForm.text.addEventListener('input', announceCount);
announceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#announce-send'); btn.disabled = true;
  try {
    const r = await api('POST', '/announce', { text: announceForm.text.value });
    const msg = { sent: '読み上げました', queued: '会話が終わったら読み上げます', offline: 'アイリスがつながっていません', busy: '待っている読み上げが多すぎます。少ししてから送ってください' }[r.status] || '送りました';
    toast(msg);
    if (r.status === 'sent' || r.status === 'queued') { announceForm.reset(); announceCount(); }
  } catch {} finally { btn.disabled = false; }
});
function load(tab) { ({ shopping: loadShopping, reminders: loadReminders, announce: async () => {}, more: loadMore })[tab]().catch(() => {}); }
load('shopping');
// 声や別のスマホでの変更を、サーバーからの知らせ（SSE）で受けて、表示中のタブを読み直す
const currentTab = () => document.querySelector('nav button[aria-selected=true]').dataset.tab;
function reloadSoon(tab) { if (tab && tab !== currentTab()) return; clearTimeout(reloadSoon.t); reloadSoon.t = setTimeout(() => load(currentTab()), 300); }
function listen() {
  const es = new EventSource('/api/events');
  let opened = false;
  es.addEventListener('shopping', () => reloadSoon('shopping'));
  es.addEventListener('reminders', () => reloadSoon('reminders'));
  // つながり直したときは、切れていた間の変更を取りこぼさないよう読み直す
  es.addEventListener('open', () => { if (opened) reloadSoon(); opened = true; });
  // 503 などで閉じられると自動ではつながり直さないので、少し待って作り直す
  es.addEventListener('error', () => { if (es.readyState === EventSource.CLOSED) setTimeout(() => { listen(); reloadSoon(); }, 5000); });
}
listen();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reloadSoon(); });
</script></body></html>`;
}
