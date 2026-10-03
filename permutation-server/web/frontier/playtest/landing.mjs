// The friend's first page (PT-B): reads the invitation from the link's fragment (`#<code>`, never
// sent to a server by the browser; kept in the address bar until Start is pressed, so a reload, a
// discarded phone tab or "open in Safari" from an app's menu still has it), makes the guest key, asks the relay whether the invitation works
// (POST /gw/f/invite-check, nothing is used up), and says in plain words what to do. The game page
// (../index.html) takes it from there. No analytics, no cookies, no third-party requests; the
// optional survey link comes from config.json next to this file.
import { preflight } from '../../session.mjs';
import { addressOf, backupText, createKey, inAppBrowser, INVITE_KEY, parseBackup, readKey, store } from './guestkey.mjs';

const T = {
  ja: {
    title: 'Wylls テスト',
    checking: ['確認しています…', '招待を確認しています。少しお待ちください。'],
    ok: ['招待を確認しました', 'まず下で「ゲスト鍵」を保存してから、はじめてください。国を一つ選ぶと、11〜21分ほどで最初の村ができます。'],
    start: 'はじめる', again: 'もう一度確認する', continue: '続きから遊ぶ',
    returning: ['おかえりなさい', 'このブラウザのゲーム用の鍵が見つかり、すでに参加しています。続きから遊べます。'],
    none: ['招待リンクが必要です', '送られてきた招待リンク（末尾に # と文字列が付いています）をそのまま開いてください。すでに参加していて、アドレスやブラウザが変わっただけの場合は、下の「鍵を持っています」に保存しておいた鍵を貼り付ければ、同じ村に戻れます。'],
    invalid: ['この招待は使えません', 'リンクが途中で切れたか、写し間違いかもしれません。リンク全体をもう一度開くか、招待してくれた人に送り直してもらってください。すでに参加している場合は、下の「鍵を持っています」に保存した鍵を貼り付けてください。'],
    used: ['この招待はすでに使われています', '招待は一人一回だけです。すでに別のブラウザやスマホで参加した場合は、下の「鍵を持っています」に、保存しておいた鍵を入れてください。心当たりがなければ、招待してくれた人に新しい招待をお願いしてください。'],
    notStarted: ['世界はまだ開いていません', '始まる時刻は招待してくれた人からの連絡のとおりです。そのころにこのリンクをもう一度開いてください。'],
    joinClosed: ['新しい参加は締め切られました', 'このテストの新規参加の期間は終わりました。参加済みの人は鍵があれば続きを遊べます。'],
    ended: ['このテストは終わりました', '遊んでくれてありがとうございました。'],
    full: ['定員に達しました', '席がすべて埋まりました。空きが出たら招待してくれた人から連絡があります。'],
    unavailable: ['いまゲームにつながりません', 'ホストのパソコンが止まっているか、通信が不安定です。Cloudflare のエラー画面が出る場合は、ホストが止まっているかアドレスが変わっています。連絡を待つか、数分おいてやり直してください。アドレスが変わったあとは、下の「鍵を持っています」に保存した鍵を貼り付ければ同じ村に戻れます。'],
    insecure: ['https で開いてください', 'この接続ではブラウザの暗号機能が使えません。招待リンクは https:// で始まるものです。'],
    oldBrowser: ['このブラウザでは遊べません', 'iPhone・iPad は iOS 17 以降が必要です（iPhone では Chrome などどのブラウザも同じ仕組みなので、ブラウザを替えても動きません）。古い iPhone の場合は、パソコンで開くか、招待してくれた人に相談してください。パソコンや Android では、最新の Chrome・Edge・Firefox で開いてください。'],
    inApp: ['Safari か Chrome で開いてください', 'このページは LINE・Instagram などのアプリの中で開かれています。この中では鍵の保存やコピーがうまく動かず、村を失うおそれがあります。「リンクをコピー」を押して、Safari か Chrome に貼り付けて開いてください（アプリのメニューの「ブラウザで開く」でも構いません）。'],
    copyLink: 'リンクをコピー', copiedLink: 'コピーしました。Safari か Chrome のアドレス欄に貼り付けてください', force: 'このままアプリ内で開く（おすすめしません）',
    noStorage: ['ブラウザが保存を許していません', 'プライベートブラウズを切るか、サイトデータの保存を許可してください。そうしないと、ページを閉じると村を失います。'],
    aboutTitle: '始める前に',
    about: [
      '未完成のゲームの内輪のテストです。数日、少しずつ遊んで、わかりにくかったところを教えてください。',
      'お金も暗号資産のウォレットも要りません。ゲーム用の「ゲスト鍵」がこのブラウザに作られます。ログインのようなもので、価値のあるものは入っていません。ゲーム画面でも「ゲーム内の鍵」を作るよう求められますが、これは自動で、保存は要りません。保存するのはこのゲスト鍵だけです。',
      '最初の村は「仮」の状態で始まり、確定まで最長で約4時間かかります。そのあいだ、収穫・建設・訓練はできますが、軍勢の編成・探索・出発は確定を待ちます。',
      '操作には1日の上限があります（1村あたり1ゲーム日に約40回。収穫・建設・訓練・出発などが1回ずつ数えられます）。',
      '名前やメールは聞きません。ランダムな参加者番号と、ゲーム内の操作の記録だけを、テストの集計のために保存します。',
      '毎回同じブラウザ・同じ端末で開いてください。ブラウザのデータを消すと村を失うので、下で鍵を保存しておくと安心です。',
      'ゲームはホストのパソコンで動いています。つながらないときは数分待って、もう一度開いてください。',
    ],
    keyTitle: '1. あなたのゲスト鍵を保存', keyBody: 'この鍵があれば、別のブラウザや消去のあと、アドレスが変わったあとでも同じ村に戻れます。ファイルに保存するか、コピーしてメモや LINE Keep に貼っておいてください。誰にも見せないでください。あとでこのページをもう一度開けば、いつでも保存できます。',
    save: '鍵をファイルに保存', copy: '鍵をコピー', copied: 'コピーしました', saved: '保存しました',
    restoreTitle: '鍵を持っています', restoreBody: '前に保存した鍵の文面（または 64 文字の英数字）をここに貼り付けてください。', restoreGo: 'この鍵を使う',
    restoreOk: '鍵を取り込みました。', restoreBad: '鍵を読み取れませんでした。保存した文面をそのまま貼り付けてください。',
    savedLabel: '鍵を保存しました（ファイル、コピー、メモのどれでも）', startTitle: '2. はじめる',
    resets: n => `1日の操作の上限は ${n} にリセットされます。`,
    survey: 'アンケートはこちら', foot: 'Wylls — 内輪のテスト。賞金や取引はありません。',
  },
  en: {
    title: 'Wylls friends playtest',
    checking: ['Checking…', 'Checking your invitation. One moment.'],
    ok: ['Your invitation works', 'First save your guest key below, then press Start. You choose one of six nations, and your first village appears about 11 to 21 minutes later.'],
    start: 'Start', again: 'Check again', continue: 'Continue playing',
    returning: ['Welcome back', 'Your guest key was found in this browser and you are already in the game. Pick up where you left off.'],
    none: ['You need an invitation link', 'Open the invitation link you were sent exactly as it is (it has a # and a code at the end). If you already joined and only the address or the browser changed, open "I already have a key" below and paste the key you saved: you get your village back.'],
    invalid: ['This invitation does not work', 'The link may have been cut off or mistyped. Open the whole link again, or ask the person who invited you to send it again. If you already joined, paste your saved key into "I already have a key" below.'],
    used: ['This invitation was already used', 'Each invitation works once. If you already joined in another browser or on another phone, put the key you saved into "I already have a key" below. If that does not ring a bell, ask the person who invited you for a new invitation.'],
    notStarted: ['The world has not opened yet', 'The start time is the one you were told. Open this link again then.'],
    joinClosed: ['New players are no longer accepted', 'The window for joining this test has closed. If you already joined, your key still lets you continue.'],
    ended: ['This test has ended', 'Thank you for playing!'],
    full: ['All the places are taken', 'Every place is filled. The person who invited you will tell you if one opens up.'],
    unavailable: ['The game is not reachable right now', 'The host computer may be off or the connection is unstable. A Cloudflare error page means the host is down or the address changed: wait for a message, or try again in a few minutes. After an address change, paste your saved key into "I already have a key" below to get your village back.'],
    insecure: ['Please open this with https', 'This connection cannot use the browser\'s security features. Invitation links start with https://.'],
    oldBrowser: ['This browser cannot play', 'On iPhone or iPad you need iOS 17 or newer (every browser on iPhone uses the same engine, so switching to Chrome does not help). With an older iPhone, use a computer or ask the person who invited you. On a computer or Android, use a recent Chrome, Edge or Firefox.'],
    inApp: ['Please open this in Safari or Chrome', 'This page is open inside another app (LINE, Instagram, ...). Saving and copying your key often fail there and you could lose your village. Press "Copy link", then paste it into Safari or Chrome (the app\'s menu may also have "Open in browser").'],
    copyLink: 'Copy link', copiedLink: 'Copied. Paste it into the address bar of Safari or Chrome', force: 'Open here anyway (not recommended)',
    noStorage: ['Your browser will not save data', 'Turn off private browsing or allow site data. Otherwise you lose your village when you close the page.'],
    aboutTitle: 'Before you start',
    about: [
      'This is a small private test of an unfinished game. Please play a little each day for a few days and tell us what was confusing.',
      'No money and no crypto wallet are needed. A "guest key" for the game is made in this browser. Think of it as a login; it holds nothing of value. The game will also ask you to create an "in-game key"; that is automatic and needs no saving. Only this guest key matters.',
      'Your first village starts as "provisional" and can take up to about 4 hours to be confirmed. Meanwhile you can harvest, build and train; mustering, exploring and marching wait for the confirmation.',
      'Each village has a daily allowance of actions (about 40 per game day; every Harvest, Build, Train, Depart and so on counts as one).',
      'We do not ask for your name or email. We keep a random player number and a record of what you did in the game, only to count how the test went.',
      'Use the same browser and the same device each time. Clearing the browser\'s data loses your village, so save your key below to be safe.',
      'The game runs on the host\'s computer. If it does not load, wait a few minutes and open it again.',
    ],
    keyTitle: '1. Save your guest key', keyBody: 'With this key you can get back to the same village from another browser, after clearing data, or after the address changes. Save it as a file, or copy it into Notes or LINE Keep. Do not show it to anyone. You can open this page again at any time to save it.',
    save: 'Save key as a file', copy: 'Copy key', copied: 'Copied', saved: 'Saved',
    restoreTitle: 'I already have a key', restoreBody: 'Paste the key text you saved before (or the 64 letters and digits).', restoreGo: 'Use this key',
    restoreOk: 'Key imported.', restoreBad: 'Could not read that key. Paste the saved text exactly as it was.',
    savedLabel: 'I saved my key (file, copy or a note)', startTitle: '2. Start',
    resets: n => `The daily allowance resets at ${n}.`,
    survey: 'Open the survey', foot: 'Wylls: a private friends test. There are no prizes or trading.',
  },
};

const $ = id => document.getElementById(id);
let lang = (() => { const s = store.get('ps-lang'); return s === 'ja' || s === 'en' ? s : (navigator.language ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en'; })();
let view = { state: 'checking' };
let cfg = {};
let resetsAt = null;
const SAVED = 'ps-key-saved-v1';

let forced = false;

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
  go.hidden = !['ok', 'returning'].includes(view.state);
  go.textContent = view.state === 'ok' ? t.start : t.continue;
  // Start waits for the key to be saved (a lost key is a lost village and a lost return in the numbers)
  const needsSave = view.state === 'ok' && !$('saved').checked;
  go.setAttribute('aria-disabled', String(needsSave));
  $('start-box').hidden = go.hidden;
  $('start-title').textContent = t.startTitle;
  $('saved-wrap').hidden = view.state !== 'ok';
  $('saved-label').textContent = t.savedLabel;
  $('retry').hidden = !['unavailable', 'notStarted', 'invalid'].includes(view.state);
  $('retry').textContent = t.again;
  const inApp = view.state === 'inApp';
  $('copy-link').hidden = !inApp;
  $('copy-link').textContent = t.copyLink;
  $('force').hidden = !inApp;
  $('force').textContent = t.force;
  // a person arriving without a working invitation may well be a returning one: the key box opens
  $('restore').open = ['none', 'invalid', 'unavailable', 'used'].includes(view.state) || $('restore').open;
  $('about-title').textContent = t.aboutTitle;
  const items = [...t.about];
  if (resetsAt) {
    const when = new Date(resetsAt * 1000).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    items.push(t.resets(when));
  }
  $('about-list').replaceChildren(...items.map(s => Object.assign(document.createElement('li'), { textContent: s })));
  $('key-box').hidden = !view.key || inApp;
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

/**
 * The invitation in the link's fragment (`#code` or `#i=code`). It stays in the address bar until Start is
 * pressed (the fragment is never sent to a server and the page sends no referrer), and a valid-looking one
 * is also kept in this browser, so a reload or a discarded tab does not lose it. A fragment that cannot be
 * decoded (`#%E0%A4%A`) is an invalid invitation, never a script error.
 */
function takeInvite() {
  let raw = (location.hash ?? '').replace(/^#/, '');
  try { raw = decodeURIComponent(raw); } catch { return '!'; }
  raw = raw.replace(/^i=/, '').trim();
  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(raw);
  if (valid) store.set(INVITE_KEY, raw);
  return valid ? raw : raw ? '!' : '';
}
let invite = takeInvite() || (store.get(INVITE_KEY) ?? '');
/** The link a person should paste into a real browser (with the invitation). */
const fullLink = () => `${location.origin}${location.pathname}${location.search}${invite && invite !== '!' ? `#i=${invite}` : ''}`;

async function evaluate() {
  view = { state: 'checking', key: view.key };
  paint();
  // PT-E: inside LINE and the like nothing is made or saved: a key made there is lost with the app's own storage
  if (inAppBrowser() && !forced) { view = { state: 'inApp' }; paint(); return; }
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
    resetsAt = Number(check?.quota?.resetsAt) || null;
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

$('go').addEventListener('click', e => {
  if ($('go').getAttribute('aria-disabled') === 'true') { e.preventDefault(); $('saved-wrap').focus?.(); return; }
  if (invite && invite !== '!' && view.state === 'ok') store.set(INVITE_KEY, invite);
  store.set('ps-lang', lang);
  // Start was pressed: the fragment has done its work (the game page takes the invitation from this browser's storage)
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep it */ }
});
const markSaved = () => { $('saved').checked = true; store.set(SAVED, '1'); paint(); };
$('saved').checked = store.get(SAVED) === '1';
$('saved').addEventListener('change', () => { store.set(SAVED, $('saved').checked ? '1' : '0'); paint(); });
$('copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(fullLink()); $('card-more').textContent = say().copiedLink; $('card-more').hidden = false; } catch {
    $('card-more').textContent = fullLink(); $('card-more').hidden = false;
  }
});
$('force').addEventListener('click', () => { forced = true; evaluate(); });
$('retry').addEventListener('click', () => { evaluate(); });
for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => { lang = b.dataset.lang; store.set('ps-lang', lang); paint(); });
$('key-copy').addEventListener('click', async () => {
  const k = readKey();
  if (!k) return;
  try { await navigator.clipboard.writeText(backupText(k)); $('key-copy').textContent = say().copied; markSaved(); } catch { $('restore-msg').textContent = ''; }
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
  markSaved();
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
