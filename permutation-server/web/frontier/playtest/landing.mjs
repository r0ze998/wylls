// The friend's first page (PT-B): reads the invitation from the link's fragment (`#<code>`, never
// sent to a server by the browser), makes the guest key, asks the relay whether the invitation works
// (POST /gw/f/invite-check, nothing is used up), and says in plain words what to do. The game page
// (../index.html) takes it from there. No analytics, no cookies, no third-party requests; the
// optional survey link comes from config.json next to this file.
import { preflight } from '../../session.mjs';
import { addressOf, backupText, createKey, INVITE_KEY, parseBackup, readKey, store } from './guestkey.mjs';

const T = {
  ja: {
    title: 'Wylls テスト',
    checking: ['確認しています…', '招待を確認しています。少しお待ちください。'],
    ok: ['招待を確認しました', '下のボタンで始められます。国を一つ選ぶと、10〜20分ほどで最初の村ができます。'],
    start: 'はじめる', again: 'もう一度確認する', continue: '続きから遊ぶ',
    returning: ['おかえりなさい', 'このブラウザのゲーム用の鍵が見つかり、すでに参加しています。続きから遊べます。'],
    none: ['招待リンクが必要です', '送られてきた招待リンク（末尾に # と文字列が付いています）をそのまま開いてください。このページだけでは始められません。'],
    invalid: ['この招待は使えません', 'リンクが途中で切れたか、写し間違いかもしれません。リンク全体をもう一度開くか、招待してくれた人に送り直してもらってください。'],
    used: ['この招待はすでに使われています', '招待は一人一回だけです。すでに別のブラウザやスマホで参加した場合は、下の「鍵を持っています」に、保存しておいた鍵を入れてください。心当たりがなければ、招待してくれた人に新しい招待をお願いしてください。'],
    notStarted: ['世界はまだ開いていません', '始まる時刻は招待してくれた人からの連絡のとおりです。そのころにこのリンクをもう一度開いてください。'],
    joinClosed: ['新しい参加は締め切られました', 'このテストの新規参加の期間は終わりました。参加済みの人は鍵があれば続きを遊べます。'],
    ended: ['このテストは終わりました', '遊んでくれてありがとうございました。'],
    full: ['定員に達しました', '席がすべて埋まりました。空きが出たら招待してくれた人から連絡があります。'],
    unavailable: ['いまゲームにつながりません', 'ホストのパソコンが止まっているか、通信が不安定です。数分おいてからやり直してください。'],
    insecure: ['https で開いてください', 'この接続ではブラウザの暗号機能が使えません。招待リンクは https:// で始まるものです。'],
    oldBrowser: ['このブラウザでは遊べません', '最新の Chrome・Edge・Firefox・Safari（17 以降）で開いてください。'],
    noStorage: ['ブラウザが保存を許していません', 'プライベートブラウズを切るか、サイトデータの保存を許可してください。そうしないと、ページを閉じると村を失います。'],
    aboutTitle: '始める前に',
    about: [
      '未完成のゲームの内輪のテストです。数日、少しずつ遊んで、わかりにくかったところを教えてください。',
      'お金も暗号資産のウォレットも要りません。ゲーム用の「ゲスト鍵」がこのブラウザに作られます。ログインのようなもので、価値のあるものは入っていません。',
      '名前やメールは聞きません。ランダムな参加者番号と、ゲーム内の操作の記録だけを、テストの集計のために保存します。',
      '毎回同じブラウザ・同じ端末で開いてください。ブラウザのデータを消すと村を失うので、下で鍵を保存しておくと安心です。',
      'ゲームはホストのパソコンで動いています。つながらないときは数分待って、もう一度開いてください。',
    ],
    keyTitle: 'あなたのゲスト鍵', keyBody: 'この鍵があれば、別のブラウザや消去のあとでも同じ村に戻れます。誰にも見せないでください。',
    save: '鍵をファイルに保存', copy: '鍵をコピー', copied: 'コピーしました', saved: '保存しました',
    restoreTitle: '鍵を持っています', restoreBody: '前に保存した鍵の文面（または 64 文字の英数字）をここに貼り付けてください。', restoreGo: 'この鍵を使う',
    restoreOk: '鍵を取り込みました。', restoreBad: '鍵を読み取れませんでした。保存した文面をそのまま貼り付けてください。',
    survey: 'アンケートはこちら', foot: 'Wylls — 内輪のテスト。賞金や取引はありません。',
  },
  en: {
    title: 'Wylls friends playtest',
    checking: ['Checking…', 'Checking your invitation. One moment.'],
    ok: ['Your invitation works', 'Press the button to start. You choose one of six nations, and your first village appears about 10 to 20 minutes later.'],
    start: 'Start', again: 'Check again', continue: 'Continue playing',
    returning: ['Welcome back', 'Your guest key was found in this browser and you are already in the game. Pick up where you left off.'],
    none: ['You need an invitation link', 'Open the invitation link you were sent exactly as it is (it has a # and a code at the end). This page alone cannot start a game.'],
    invalid: ['This invitation does not work', 'The link may have been cut off or mistyped. Open the whole link again, or ask the person who invited you to send it again.'],
    used: ['This invitation was already used', 'Each invitation works once. If you already joined in another browser or on another phone, put the key you saved into "I already have a key" below. If that does not ring a bell, ask the person who invited you for a new invitation.'],
    notStarted: ['The world has not opened yet', 'The start time is the one you were told. Open this link again then.'],
    joinClosed: ['New players are no longer accepted', 'The window for joining this test has closed. If you already joined, your key still lets you continue.'],
    ended: ['This test has ended', 'Thank you for playing!'],
    full: ['All the places are taken', 'Every place is filled. The person who invited you will tell you if one opens up.'],
    unavailable: ['The game is not reachable right now', 'The host computer may be off or the connection is unstable. Wait a few minutes and try again.'],
    insecure: ['Please open this with https', 'This connection cannot use the browser\'s security features. Invitation links start with https://.'],
    oldBrowser: ['This browser cannot play', 'Please use a recent Chrome, Edge, Firefox or Safari (17 or newer).'],
    noStorage: ['Your browser will not save data', 'Turn off private browsing or allow site data. Otherwise you lose your village when you close the page.'],
    aboutTitle: 'Before you start',
    about: [
      'This is a small private test of an unfinished game. Please play a little each day for a few days and tell us what was confusing.',
      'No money and no crypto wallet are needed. A "guest key" for the game is made in this browser. Think of it as a login; it holds nothing of value.',
      'We do not ask for your name or email. We keep a random player number and a record of what you did in the game, only to count how the test went.',
      'Use the same browser and the same device each time. Clearing the browser\'s data loses your village, so save your key below to be safe.',
      'The game runs on the host\'s computer. If it does not load, wait a few minutes and open it again.',
    ],
    keyTitle: 'Your guest key', keyBody: 'With this key you can get back to the same village from another browser or after clearing data. Do not show it to anyone.',
    save: 'Save key as a file', copy: 'Copy key', copied: 'Copied', saved: 'Saved',
    restoreTitle: 'I already have a key', restoreBody: 'Paste the key text you saved before (or the 64 letters and digits).', restoreGo: 'Use this key',
    restoreOk: 'Key imported.', restoreBad: 'Could not read that key. Paste the saved text exactly as it was.',
    survey: 'Open the survey', foot: 'Wylls: a private friends test. There are no prizes or trading.',
  },
};

const $ = id => document.getElementById(id);
let lang = (() => { const s = store.get('ps-lang'); return s === 'ja' || s === 'en' ? s : (navigator.language ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en'; })();
let view = { state: 'checking' };
let cfg = {};

const say = () => T[lang];
const fmtTitle = () => { document.title = say().title; $('title').textContent = say().title; document.documentElement.lang = lang; };

function paint() {
  const t = say();
  fmtTitle();
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  const [title, body] = t[view.state] ?? t.unavailable;
  $('card-title').textContent = title;
  $('card-body').textContent = body;
  $('card').dataset.tone = ['ok', 'returning'].includes(view.state) ? 'ok' : ['checking'].includes(view.state) ? '' : 'warn';
  const go = $('go');
  go.hidden = !['ok', 'returning', 'used'].includes(view.state) || (view.state === 'used' && !view.hasCitizen);
  go.textContent = view.state === 'ok' ? t.start : t.continue;
  $('retry').hidden = !['unavailable', 'notStarted', 'invalid'].includes(view.state);
  $('retry').textContent = t.again;
  $('about-title').textContent = t.aboutTitle;
  $('about-list').replaceChildren(...t.about.map(s => Object.assign(document.createElement('li'), { textContent: s })));
  $('key-box').hidden = !view.key;
  $('key-title').textContent = t.keyTitle;
  $('key-body').textContent = t.keyBody;
  $('key-save').textContent = t.save;
  $('key-copy').textContent = t.copy;
  $('restore-title').textContent = t.restoreTitle;
  $('restore-body').textContent = t.restoreBody;
  $('restore-go').textContent = t.restoreGo;
  const foot = $('foot');
  foot.replaceChildren(document.createTextNode(t.foot));
  if (typeof cfg.surveyUrl === 'string' && /^https:\/\//.test(cfg.surveyUrl)) {
    foot.append(document.createElement('br'), Object.assign(document.createElement('a'), { href: cfg.surveyUrl, textContent: t.survey, rel: 'noopener noreferrer' }));
  }
}

async function getJson(url, init) {
  const r = await fetch(url, { cache: 'no-store', ...init });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json: j };
}

/** The invitation in the link's fragment (`#code` or `#i=code`), removed from the address bar. */
function takeInvite() {
  const raw = decodeURIComponent((location.hash ?? '').replace(/^#/, '')).replace(/^i=/, '').trim();
  if (raw) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep it */ } }
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : raw ? '!' : '';
}
let invite = takeInvite() || (store.get(INVITE_KEY) ?? '');

async function evaluate() {
  view = { state: 'checking', key: view.key };
  paint();
  const pf = await preflight();
  if (!pf.ok) { view = { state: pf.code === 'InsecureContext' ? 'insecure' : 'oldBrowser' }; paint(); return; }
  let key = readKey();
  let persisted = true;
  if (!key) ({ key, persisted } = await createKey());
  view = { state: 'checking', key };
  if (!persisted) { view = { state: 'noStorage', key }; paint(); return; }
  const address = addressOf(key);
  let me = null;
  let check = null;
  try {
    const [m, c] = await Promise.all([
      getJson(`/h/me/${address}`),
      getJson('/gw/f/invite-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: invite === '!' ? '' : invite }) }),
    ]);
    me = m.status === 200 ? m.json : null;
    check = c.status === 200 && c.json?.ok ? c.json : null;
  } catch { /* the host is off or the network is down */ }
  if (!me && !check) { view = { state: 'unavailable', key }; paint(); return; }
  const hasCitizen = !!me?.citizen;
  if (hasCitizen) { view = { state: 'returning', key, hasCitizen }; paint(); return; }
  if (!check) { view = { state: 'unavailable', key }; paint(); return; }
  const season = check.season;
  const state = season === 'ended' ? 'ended' : season === 'joinClosed' ? 'joinClosed' : season === 'notStarted' ? 'notStarted' : season === 'unavailable' ? 'unavailable'
    : check.invite === 'notNeeded' ? 'ok' : !invite ? 'none' : check.invite === 'invalid' ? 'invalid' : check.invite === 'used' ? 'used' : check.full ? 'full' : 'ok';
  view = { state, key, hasCitizen };
  paint();
}

$('go').addEventListener('click', () => {
  if (invite && invite !== '!' && view.state === 'ok') store.set(INVITE_KEY, invite);
  store.set('ps-lang', lang);
});
$('retry').addEventListener('click', () => { evaluate(); });
for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => { lang = b.dataset.lang; store.set('ps-lang', lang); paint(); });
$('key-copy').addEventListener('click', async () => {
  const k = readKey();
  if (!k) return;
  try { await navigator.clipboard.writeText(backupText(k)); $('key-copy').textContent = say().copied; } catch { $('restore-msg').textContent = ''; }
});
$('key-save').addEventListener('click', () => {
  const k = readKey();
  if (!k) return;
  const url = URL.createObjectURL(new Blob([backupText(k)], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'wylls-guest-key.txt' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  $('key-save').textContent = say().saved;
});
$('restore-go').addEventListener('click', async () => {
  const seed = parseBackup($('restore-text').value);
  if (!seed) { $('restore-msg').textContent = say().restoreBad; return; }
  await createKey(seed);
  $('restore-text').value = '';
  $('restore-msg').textContent = say().restoreOk;
  await evaluate();
});

try { cfg = (await getJson('config.json')).json ?? {}; } catch { cfg = {}; }
await evaluate();
