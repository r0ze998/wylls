/*
 * 真 −SHIN−  問い合わせフォーム（入力 → 確認 → 送信）
 * ------------------------------------------------------------------
 * - 入力値はページ内（メモリ）にのみ保持。localStorage や外部サービスへは保存しない
 * - SHIN_CONFIG.form.endpoint が空ならデモ動作：送信せず「送信していない」ことを明示する
 * - endpoint があれば fetch で JSON を POST。2xx が返ったときだけ「送信しました」と表示する
 * - 送信中はボタンを無効化し、二重送信を防ぐ
 */
(function () {
  "use strict";

  var cfg = (window.SHIN_CONFIG && window.SHIN_CONFIG.form) || {};
  var endpoint = (cfg.endpoint || "").trim();

  var form = document.getElementById("contact-form");
  if (!form) return;

  var viewInput = document.getElementById("view-input");
  var viewConfirm = document.getElementById("view-confirm");
  var viewResult = document.getElementById("view-result");
  var steps = document.querySelectorAll(".steps li");
  var summary = document.getElementById("error-summary");
  var summaryList = summary.querySelector("ul");
  var confirmBody = document.getElementById("confirm-body");
  var btnBack = document.getElementById("btn-back");
  var btnSend = document.getElementById("btn-send");
  var sendStatus = document.getElementById("send-status");
  var submitting = false;

  /* 項目定義：確認画面の並びとラベルもここで決める */
  var FIELDS = [
    { name: "company",   label: "会社名・店舗名",       required: true },
    { name: "person",    label: "ご担当者名",           required: true },
    { name: "division",  label: "部署・役職",           required: false },
    { name: "email",     label: "メールアドレス",       required: true,  type: "email" },
    { name: "tel",       label: "電話番号",             required: false, type: "tel" },
    { name: "pref",      label: "作業場所の都道府県",   required: false },
    { name: "building",  label: "建物の種類",           required: false },
    { name: "units",     label: "台数・機種の目安",     required: false },
    { name: "timing",    label: "ご希望の時期",         required: false },
    { name: "message",   label: "ご相談内容",           required: true,  minLength: 10 },
    { name: "consent",   label: "入力内容の取り扱い",   required: true,  type: "checkbox" }
  ];

  function el(name) { return form.elements[name]; }
  function fieldWrap(name) { var i = el(name); return i ? i.closest(".field") : null; }

  function valueOf(name) {
    var i = el(name);
    if (!i) return "";
    if (i.type === "checkbox") return i.checked ? "同意する" : "";
    if (i.tagName === "SELECT") {
      var opt = i.options[i.selectedIndex];
      return opt && opt.value ? opt.textContent.trim() : "";
    }
    return (i.value || "").trim();
  }

  /* ---------- 検証 ---------- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var TEL_RE = /^\+?[0-9０-９\-－()（）\s]{10,20}$/;

  function validateField(f) {
    var i = el(f.name);
    var v = i.type === "checkbox" ? (i.checked ? "on" : "") : (i.value || "").trim();
    if (f.required && !v) {
      return f.type === "checkbox" ? "取り扱いへの同意にチェックを入れてください。" : f.label + "を入力してください。";
    }
    if (!v) return "";
    if (f.type === "email" && !EMAIL_RE.test(v)) return "メールアドレスの形式が正しくありません（例：name@example.co.jp）。";
    if (f.type === "tel" && !TEL_RE.test(v)) return "電話番号は数字とハイフンで入力してください（例：03-0000-0000）。";
    if (f.minLength && v.length < f.minLength) return f.label + "は" + f.minLength + "文字以上でお書きください。";
    return "";
  }

  function showError(f, msg) {
    var wrap = fieldWrap(f.name);
    var i = el(f.name);
    var err = wrap ? wrap.querySelector(".field__error") : null;
    if (!wrap || !i) return;
    if (msg) {
      wrap.classList.add("has-error");
      i.setAttribute("aria-invalid", "true");
      if (err) { err.textContent = msg; }
    } else {
      wrap.classList.remove("has-error");
      i.removeAttribute("aria-invalid");
      if (err) { err.textContent = ""; }
    }
  }

  function validateAll() {
    var errors = [];
    FIELDS.forEach(function (f) {
      var msg = validateField(f);
      showError(f, msg);
      if (msg) errors.push({ f: f, msg: msg });
    });
    return errors;
  }

  function renderSummary(errors) {
    summaryList.innerHTML = "";
    if (!errors.length) { summary.classList.remove("is-visible"); return; }
    errors.forEach(function (e) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + el(e.f.name).id;
      a.textContent = e.msg;
      a.addEventListener("click", function (ev) { ev.preventDefault(); el(e.f.name).focus(); });
      li.appendChild(a);
      summaryList.appendChild(li);
    });
    summary.classList.add("is-visible");
    summary.focus();
  }

  /* 入力し直したら、その項目のエラーは消す */
  FIELDS.forEach(function (f) {
    var i = el(f.name);
    if (!i) return;
    var ev = (i.type === "checkbox" || i.tagName === "SELECT") ? "change" : "input";
    i.addEventListener(ev, function () {
      if (fieldWrap(f.name).classList.contains("has-error")) {
        var msg = validateField(f);
        showError(f, msg);
        if (!msg && !form.querySelector(".has-error")) summary.classList.remove("is-visible");
      }
    });
    i.addEventListener("blur", function () {
      if (i.type === "checkbox") return;
      var msg = validateField(f);
      if (msg && (i.value || "").trim()) showError(f, msg); /* 入力済みで形式不備のときだけ即時表示 */
    });
  });

  /* ---------- 画面切り替え ---------- */
  function setStep(n) {
    steps.forEach(function (li, idx) {
      li.classList.toggle("is-done", idx < n);
      if (idx === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }

  function show(view) {
    [viewInput, viewConfirm, viewResult].forEach(function (v) { v.hidden = v !== view; });
    var h = view.querySelector("h2");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
    var card = document.querySelector(".form-card");
    if (card) {
      var top = card.getBoundingClientRect().top + window.scrollY - 100;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }

  function buildConfirm() {
    confirmBody.innerHTML = "";
    FIELDS.forEach(function (f) {
      var tr = document.createElement("tr");
      var th = document.createElement("th"); th.scope = "row"; th.textContent = f.label;
      var td = document.createElement("td");
      var v = valueOf(f.name);
      if (v) { td.textContent = v; } else { td.textContent = "（未入力）"; td.className = "empty"; }
      tr.appendChild(th); tr.appendChild(td);
      confirmBody.appendChild(tr);
    });
  }

  /* 入力 → 確認 */
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (el("website") && el("website").value) { return; } /* ハニーポット：bot はここで止まる */
    var errors = validateAll();
    renderSummary(errors);
    if (errors.length) return;
    buildConfirm();
    setStep(1);
    show(viewConfirm);
  });

  /* 確認 → 入力（修正） */
  btnBack.addEventListener("click", function () {
    setStep(0);
    show(viewInput);
  });

  /* 確認 → 送信（またはデモ） */
  btnSend.addEventListener("click", function () {
    if (submitting) return;
    submitting = true;
    btnSend.disabled = true;
    btnBack.disabled = true;
    btnSend.setAttribute("aria-busy", "true");
    sendStatus.classList.remove("is-error");

    var payload = {};
    FIELDS.forEach(function (f) { payload[f.name] = valueOf(f.name); });
    payload.page = location.href;
    payload.submittedAt = new Date().toISOString();

    if (!endpoint) {
      /* デモ：送信は行わない。「受付完了」とは表示しない */
      sendStatus.textContent = "デモ環境のため、送信処理は行いません…";
      setTimeout(function () {
        renderResult("demo");
        setStep(2);
        show(viewResult);
        resetSending();
      }, 500);
      return;
    }

    sendStatus.textContent = "送信しています…";
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;

    fetch(endpoint, {
      method: cfg.method || "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      renderResult("sent");
      setStep(2);
      show(viewResult);
      form.reset();
    }).catch(function (err) {
      sendStatus.classList.add("is-error");
      sendStatus.textContent = "送信できませんでした（" + (err && err.name === "AbortError" ? "時間切れ" : (err && err.message) || "エラー") + "）。時間をおいて再度お試しいただくか、別の方法でご連絡ください。";
    }).then(function () {
      if (timer) clearTimeout(timer);
      resetSending();
    });
  });

  function resetSending() {
    submitting = false;
    btnSend.disabled = false;
    btnBack.disabled = false;
    btnSend.removeAttribute("aria-busy");
    if (!sendStatus.classList.contains("is-error")) sendStatus.textContent = "";
  }

  function renderResult(kind) {
    var demo = document.getElementById("result-demo");
    var sent = document.getElementById("result-sent");
    demo.hidden = kind !== "demo";
    sent.hidden = kind !== "sent";
  }

  /* 結果画面 → 最初から */
  var btnRestart = document.getElementById("btn-restart");
  if (btnRestart) {
    btnRestart.addEventListener("click", function () {
      form.reset();
      FIELDS.forEach(function (f) { showError(f, ""); });
      summary.classList.remove("is-visible");
      setStep(0);
      show(viewInput);
    });
  }

  /* 離脱時の注意：入力途中でページを離れるときだけ確認 */
  window.addEventListener("beforeunload", function (e) {
    if (viewResult.hidden === false) return;
    var dirty = FIELDS.some(function (f) { var i = el(f.name); return i && (i.type === "checkbox" ? i.checked : (i.value || "").trim()); });
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
})();
