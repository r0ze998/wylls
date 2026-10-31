/* 真 −SHIN−  共通スクリプト（依存ライブラリなし） */
(function () {
  "use strict";

  document.documentElement.classList.remove("no-js");

  /* ---------- 設定値の流し込み（未設定なら「確認中」のまま） ---------- */
  var cfg = window.SHIN_CONFIG || {};
  document.querySelectorAll("[data-config]").forEach(function (el) {
    var path = el.getAttribute("data-config").split(".");
    var v = cfg;
    for (var i = 0; i < path.length; i++) { v = v ? v[path[i]] : undefined; }
    if (typeof v === "string" && v.trim() !== "") {
      el.textContent = v;
      el.classList.remove("tbd");
      var href = el.getAttribute("data-config-href");
      if (href && el.tagName === "A") { el.setAttribute("href", href + v); }
    }
  });

  /* ---------- ヘッダー：スクロールで下線 ---------- */
  var header = document.querySelector(".site-header");
  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- モバイルメニュー ---------- */
  var toggle = document.querySelector(".nav-toggle");
  var panel = document.getElementById("nav-panel");
  var main = document.getElementById("main");
  var footer = document.querySelector(".site-footer");
  var lastFocus = null;

  function setInert(on) {
    [main, footer].forEach(function (el) {
      if (!el) return;
      if (on) { el.setAttribute("inert", ""); } else { el.removeAttribute("inert"); }
    });
  }

  function openNav() {
    if (!panel || !toggle) return;
    lastFocus = document.activeElement;
    panel.classList.add("is-open");
    panel.removeAttribute("hidden");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "メニューを閉じる");
    document.body.classList.add("nav-open");
    setInert(true);
    var first = panel.querySelector("a, button");
    if (first) first.focus();
  }

  function closeNav(returnFocus) {
    if (!panel || !toggle) return;
    panel.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "メニューを開く");
    document.body.classList.remove("nav-open");
    setInert(false);
    if (returnFocus !== false && lastFocus && typeof lastFocus.focus === "function") { lastFocus.focus(); }
  }

  if (toggle && panel) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      if (open) { closeNav(); } else { openNav(); }
    });
    panel.addEventListener("click", function (e) {
      var a = e.target.closest("a");
      if (a) { closeNav(false); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") { closeNav(); }
    });
    var mq = window.matchMedia("(min-width: 1200px)");
    var onMq = function (ev) { if (ev.matches) { closeNav(false); } };
    if (mq.addEventListener) { mq.addEventListener("change", onMq); } else { mq.addListener(onMq); }
  }

  /* ---------- スクロールで現れる要素 ---------- */
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var reveals = document.querySelectorAll(".reveal");
  if (!reduce && "IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-visible"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  }

  /* ---------- チェックリスト：コピー／印刷 ---------- */
  var copyBtn = document.getElementById("copy-checklist");
  var printBtn = document.getElementById("print-checklist");
  var status = document.getElementById("checklist-status");

  function buildChecklistText() {
    var lines = ["【真 −SHIN−】見積もりのためにご確認いただきたい情報", ""];
    document.querySelectorAll(".check-group").forEach(function (g) {
      var title = g.querySelector(".check-group__title");
      lines.push("■ " + (title ? title.textContent.trim() : ""));
      g.querySelectorAll(".check-item").forEach(function (item) {
        var cb = item.querySelector("input[type=checkbox]");
        var label = item.querySelector(".check-item__label");
        var hint = item.querySelector(".check-item__hint");
        var mark = cb && cb.checked ? "[x]" : "[ ]";
        var t = mark + " " + (label ? label.textContent.trim() : "");
        if (hint) { t += "（" + hint.textContent.trim() + "）"; }
        lines.push(t);
      });
      lines.push("");
    });
    lines.push("※ わからない項目は空欄のままで構いません。ご相談時に一緒に確認します。");
    return lines.join("\n");
  }

  function say(msg) {
    if (!status) return;
    status.textContent = msg;
    clearTimeout(say._t);
    say._t = setTimeout(function () { status.textContent = ""; }, 4000);
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var text = buildChecklistText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          say("チェックリストをコピーしました。社内のメールやチャットに貼り付けてお使いください。");
        }, function () { fallbackCopy(text); });
      } else { fallbackCopy(text); }
    });
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    say(ok ? "チェックリストをコピーしました。" : "コピーできませんでした。お手数ですが、画面の内容を選択してコピーしてください。");
  }

  if (printBtn) {
    printBtn.addEventListener("click", function () { window.print(); });
  }
})();
