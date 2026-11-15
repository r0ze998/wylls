// Served after the keyless wallet and key guard (server.mjs prepends them and `const QA = {...}`), before app.mjs.
// Not imported by anything on disk: this text is a part of /__qa/client.mjs.

// The clock held at the record's time, as the screen tests hold it (page.clock.setFixedTime): the season in the
// record is long past by the wall clock, and the page would call every reading stale. Timers still run; countdowns
// do not move. Said on the strip.
if (QA.fixedMs !== null) {
  const Real = Date, now = () => QA.fixedMs;
  // (a proxy, so `new Date(x)`, `Date.UTC`, `Date.parse`, `instanceof Date` and a bare `Date()` all stay Date's own)
  globalThis.Date = new Proxy(Real, {
    construct: (target, a, newTarget) => Reflect.construct(target, a.length ? a : [QA.fixedMs], newTarget === globalThis.Date ? target : newTarget),
    apply: () => new Real(QA.fixedMs).toString(),
    get: (target, key) => (key === 'now' ? now : Reflect.get(target, key)),
  });
}

// What the page is, always in sight; it takes no taps (pointer-events: none in qa.css).
{
  const en = (localStorage.getItem('ps-lang') ?? 'ja') === 'en';
  const strip = document.createElement('p');
  strip.id = 'qa-strip';
  strip.setAttribute('role', 'note');
  strip.textContent = (en ? QA.label.en : QA.label.ja)
    + (QA.fixedMs !== null ? (en ? ' Clock held at the record\'s time.' : '（時刻は記録時点に固定）') : '');
  document.body.append(strip);
  document.documentElement.dataset.qa = 'recorded';
}

// A send that is tried is refused by the server (405) and by the wallet; both are counted for the tester:
// window.__keyUses (key operations and signatures asked) and GET /__qa/status (refused writes).
window.__qa = Object.freeze({ recorded: true, live: false, stage: QA.stage, wallet: QA.wallet, clockHeldAt: QA.fixedMs });
