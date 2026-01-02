/* Т-банк
   Без авторизации, без сервера.
   Данные хранятся локально (localStorage), можно экспортировать/импортировать JSON.
*/

const STORAGE_KEY = "walletSandbox.v1";

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function fmtMoney(n, currency="₽") {
  const num = Number(n || 0);
  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);
  return `${sign}${currency}${abs.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`;
}

function nowISO() {
  return new Date().toISOString();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw);
    // простая валидация
    if (!parsed || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.activity)) return seedState();
    return parsed;
  } catch {
    return seedState();
  }
}

function seedState() {
  const a1 = { id: uid(), name: "Основной кошелёк", currency: "₽", balance: 12500 };
  const a2 = { id: uid(), name: "Накопления", currency: "₽", balance: 50000 };
  const state = {
    meta: { app: "Т-банк", demo: true, createdAt: nowISO() },
    accounts: [a1, a2],
    activity: [
      { id: uid(), ts: nowISO(), type: "note", title: "Добро пожаловать", details: "Добро пожаловать в Ваш новый мобильный банк" }
    ],
    settings: { haptics: false }
  };
  saveState(state);
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let route = "accounts";

const appEl = document.getElementById("app");
const exportBtn = document.getElementById("btnExport");
const fileImport = document.getElementById("fileImport");

function setRoute(r) {
  route = r;
  document.querySelectorAll(".tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.route === r);
  });
  render();
}

function accountById(id) {
  return state.accounts.find(a => a.id === id);
}

function pushActivity(entry) {
  state.activity.unshift({ id: uid(), ts: nowISO(), ...entry });
}

function render() {
  if (route === "accounts") renderAccounts();
  else if (route === "transfer") renderTransfer();
  else if (route === "activity") renderActivity();
  else if (route === "settings") renderSettings();
}

function renderAccounts() {
  const total = state.accounts.reduce((s,a)=> s + Number(a.balance||0), 0);
  appEl.innerHTML = `
    <section class="card">
      <div class="row">
        <div class="col">
          <div class="h1">Общий баланс</div>
          <div class="small">Сумма по всем счётам</div>
        </div>
        <div class="badge-demo">⭐️</div>
      </div>
      <div class="hr"></div>
      <div class="row">
        <div class="money">${fmtMoney(total, state.accounts[0]?.currency || "₽")} <small>руб</small></div>
        <button class="btn primary" id="btnAddAccount">+ Счёт</button>
      </div>
    </section>

    <section class="card">
      <div class="h2">Счёта</div>
      <div class="small">Нажмите на счёт, чтобы увидеть детали</div>
      <div class="hr"></div>
      <div class="list" id="accountsList"></div>
    </section>
  `;

  const list = document.getElementById("accountsList");
  list.innerHTML = state.accounts.map(a => `
    <div class="item" data-id="${a.id}">
      <div class="left">
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="meta">Валюта: ${escapeHtml(a.currency)} · ID: ${a.id.slice(0,6)}…</div>
      </div>
      <div class="amt">${fmtMoney(a.balance, a.currency)}</div>
    </div>
  `).join("");

  document.getElementById("btnAddAccount").onclick = () => modalAddAccount();
  document.querySelectorAll(".item[data-id]").forEach(el => {
    el.onclick = () => modalEditBalance(el.dataset.id);
  });
}

function renderTransfer() {
  const opts = state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)} (${fmtMoney(a.balance,a.currency)})</option>`).join("");
  appEl.innerHTML = `
    <section class="card">
      <div class="h1">Перевод между счётами</div>
      <div class="small">срок зачисления до суток</div>
      <div class="hr"></div>

      <div class="grid">
        <div>
          <label>Со счёта</label>
          <select id="fromAcc">${opts}</select>
        </div>
        <div>
          <label>На счёт</label>
          <select id="toAcc">${opts}</select>
        </div>
        <div>
          <label>Сумма</label>
          <input class="input" id="amount" inputmode="decimal" placeholder="Например: 1500" />
        </div>
        <button class="btn primary" id="btnDoTransfer">Перевести</button>
        <div class="note">Примечание: комиссия будет рассчитана отдельно.</div>
      </div>
    </section>
    <section class="card">
      <div class="h2">Быстрые действия</div>
      <div class="small">Записи для истории (не меняют балансы автоматически)</div>
      <div class="hr"></div>
      <div class="grid two">
        <button class="btn" id="btnIncome">+ Поступление</button>
        <button class="btn danger" id="btnExpense">− Расход</button>
      </div>
    </section>

  `;

  document.getElementById("btnIncome").onclick = () => modalQuickEntry("income");
  document.getElementById("btnExpense").onclick = () => modalQuickEntry("expense");

  document.getElementById("btnDoTransfer").onclick = () => {
    const fromId = document.getElementById("fromAcc").value;
    const toId = document.getElementById("toAcc").value;
    const amt = Number(String(document.getElementById("amount").value).replace(",", "."));
    if (!fromId || !toId) return toast("Выберите счета");
    if (fromId === toId) return toast("Выберите разные счета");
    if (!amt || amt <= 0) return toast("Введите сумму > 0");

    const from = accountById(fromId);
    const to = accountById(toId);
    if (!from || !to) return toast("Счёт не найден");

    // В демо допускаем разную “валюту”, но переводим как число.
    from.balance = Number(from.balance || 0) - amt;
    to.balance = Number(to.balance || 0) + amt;

    pushActivity({
      type: "transfer",
      title: "Перевод",
      details: `${from.name} → ${to.name}`,
      amount: amt,
      currency: from.currency
    });

    saveState(state);
    toast("Готово");
    render();
  };
}

function renderActivity() {
  appEl.innerHTML = `
    <section class="card">
      <div class="h1">История</div>
      <div class="small">История транзакций</div>
      <div class="hr"></div>
      <div class="list" id="activityList"></div>
      <div class="hr"></div>
      <button class="btn danger" id="btnClearActivity">Очистить историю</button>
    </section>
  `;

  const list = document.getElementById("activityList");
  if (!state.activity.length) {
    list.innerHTML = `<div class="note">Пока пусто.</div>`;
  } else {
    list.innerHTML = state.activity.map(e => {
      const ts = new Date(e.ts).toLocaleString("ru-RU", { dateStyle:"medium", timeStyle:"short" });
      let amtHtml = "";
      if (e.type === "income") amtHtml = `<div class="amt pos">+${fmtMoney(e.amount, e.currency)}</div>`;
      if (e.type === "expense") amtHtml = `<div class="amt neg">-${fmtMoney(e.amount, e.currency)}</div>`;
      if (e.type === "transfer") amtHtml = `<div class="amt">${fmtMoney(e.amount, e.currency)}</div>`;
      return `
        <div class="item">
          <div class="left">
            <div class="name">${escapeHtml(e.title || "Событие")}</div>
            <div class="meta">${escapeHtml(e.details || "")} · ${ts}</div>
          </div>
          ${amtHtml}
        </div>
      `;
    }).join("");
  }

  document.getElementById("btnClearActivity").onclick = () => {
    state.activity = [];
    pushActivity({ type:"note", title:"История очищена", details:"" });
    saveState(state);
    render();
  };
}

function renderSettings() {
  appEl.innerHTML = `
    <section class="card">
      <div class="h1">Настройки</div>
      <div class="small">Параметры приложения</div>
      <div class="hr"></div>

      <div class="grid">
        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Импорт / Экспорт</div>
          <div class="small">Перенос данных между устройствами (JSON)</div>
          <div class="hr"></div>
          <div class="grid two">
            <button class="btn" id="btnImport">Импорт</button>
            <button class="btn" id="btnExport2">Экспорт</button>
          </div>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Сброс</div>
          <div class="small">Сбросить все настройки</div>
          <div class="hr"></div>
          <button class="btn danger" id="btnReset">Сбросить всё</button>
        </div>

        <div class="note">
          <strong>Важно:</strong> версия 1.025.34 - следите за обновлениями.
        </div>
      </div>
    </section>
  `;

  document.getElementById("btnImport").onclick = () => fileImport.click();
  document.getElementById("btnExport2").onclick = () => doExport();
  document.getElementById("btnReset").onclick = () => {
    if (!confirm("Сбросить данные?")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = seedState();
    toast("Сброшено");
    render();
  };
}

function modalAddAccount() {
  const html = `
    <div class="h2">Новый счёт</div>
    <div class="hr"></div>
    <div class="grid">
      <div>
        <label>Название</label>
        <input class="input" id="mName" placeholder="Например: Карманные" />
      </div>
      <div>
        <label>Валюта (символ)</label>
        <input class="input" id="mCur" placeholder="₽" value="₽" />
      </div>
      <div>
        <label>Стартовый баланс</label>
        <input class="input" id="mBal" inputmode="decimal" placeholder="0" value="0" />
      </div>
      <button class="btn primary" id="mOk">Создать</button>
      <button class="btn ghost" id="mCancel">Отмена</button>
    </div>
  `;
  showModal(html);

  document.getElementById("mOk").onclick = () => {
    const name = (document.getElementById("mName").value || "").trim() || "Новый счёт";
    const currency = (document.getElementById("mCur").value || "₽").trim() || "₽";
    const bal = Number(String(document.getElementById("mBal").value).replace(",", "."));
    state.accounts.push({ id: uid(), name, currency, balance: isFinite(bal) ? bal : 0 });
    pushActivity({ type:"note", title:"Создан счёт", details: name });
    saveState(state);
    closeModal();
    render();
  };
  document.getElementById("mCancel").onclick = closeModal;
}

function modalEditBalance(accId) {
  const acc = accountById(accId);
  if (!acc) return;

  const html = `
    <div class="h2">Редактировать баланс</div>
    <div class="small">Счёт: <strong>${escapeHtml(acc.name)}</strong></div>
    <div class="hr"></div>
    <div class="grid">
      <div>
        <label>Баланс</label>
        <input class="input" id="mBal" inputmode="decimal" value="${String(acc.balance ?? 0)}" />
      </div>
      <div class="grid two">
        <button class="btn primary" id="mOk">Сохранить</button>
        <button class="btn danger" id="mDel">Удалить</button>
      </div>
      <button class="btn ghost" id="mCancel">Закрыть</button>
    </div>
  `;
  showModal(html);

  document.getElementById("mOk").onclick = () => {
    const bal = Number(String(document.getElementById("mBal").value).replace(",", "."));
    acc.balance = isFinite(bal) ? bal : acc.balance;
    pushActivity({ type:"note", title:"Пополнение", details: acc.name });
    saveState(state);
    closeModal();
    render();
  };

  document.getElementById("mDel").onclick = () => {
    if (!confirm("Удалить счёт?")) return;
    state.accounts = state.accounts.filter(a => a.id !== accId);
    pushActivity({ type:"note", title:"Счёт удалён", details: acc.name });
    saveState(state);
    closeModal();
    render();
  };

  document.getElementById("mCancel").onclick = closeModal;
}

function modalQuickEntry(kind) {
  const isIncome = kind === "income";
  const title = isIncome ? "Поступление" : "Расход";
  const html = `
    <div class="h2">${title}</div>
    <div class="small">Запись попадёт в историю. Балансы не меняются автоматически.</div>
    <div class="hr"></div>
    <div class="grid">
      <div>
        <label>Сумма</label>
        <input class="input" id="mAmt" inputmode="decimal" placeholder="Например: 300" />
      </div>
      <div>
        <label>Описание</label>
        <input class="input" id="mTxt" placeholder="Например: Кофе" />
      </div>
      <button class="btn primary" id="mOk">Добавить</button>
      <button class="btn ghost" id="mCancel">Отмена</button>
    </div>
  `;
  showModal(html);

  document.getElementById("mOk").onclick = () => {
    const amt = Number(String(document.getElementById("mAmt").value).replace(",", "."));
    if (!amt || amt <= 0) return toast("Введите сумму > 0");
    const txt = (document.getElementById("mTxt").value || "").trim();
    pushActivity({
      type: kind,
      title,
      details: txt || "Без описания",
      amount: amt,
      currency: state.accounts[0]?.currency || "₽"
    });
    saveState(state);
    closeModal();
    render();
  };
  document.getElementById("mCancel").onclick = closeModal;
}

/* ===== modal/toast helpers ===== */

let modalEl = null;
function showModal(innerHtml) {
  closeModal();
  modalEl = document.createElement("div");
  modalEl.style.position = "fixed";
  modalEl.style.inset = "0";
  modalEl.style.zIndex = "999";
  modalEl.style.background = "rgba(0,0,0,.45)";
  modalEl.style.display = "grid";
  modalEl.style.placeItems = "center";
  modalEl.style.padding = "14px";
  modalEl.innerHTML = `
    <div class="card" style="width:min(520px, 100%);">
      ${innerHtml}
    </div>
  `;
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeModal();
  });
  document.body.appendChild(modalEl);
}

function closeModal() {
  if (modalEl) modalEl.remove();
  modalEl = null;
}

let toastTimer = null;
function toast(msg) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.position = "fixed";
  el.style.left = "50%";
  el.style.bottom = "90px";
  el.style.transform = "translateX(-50%)";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "999px";
  el.style.background = "rgba(0,0,0,.65)";
  el.style.border = "1px solid rgba(255,255,255,.18)";
  el.style.color = "white";
  el.style.zIndex = "9999";
  el.style.backdropFilter = "blur(10px)";
  document.body.appendChild(el);

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 1400);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* ===== export/import ===== */

function doExport() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "wallet-sandbox-data.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportBtn.onclick = () => doExport();

fileImport.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const txt = await file.text();
    const obj = JSON.parse(txt);
    if (!obj || !Array.isArray(obj.accounts) || !Array.isArray(obj.activity)) throw new Error("bad");
    state = obj;
    pushActivity({ type:"note", title:"Импорт выполнен", details:"" });
    saveState(state);
    toast("Импортировано");
    render();
    setRoute("accounts");
  } catch {
    toast("Не удалось импортировать JSON");
  } finally {
    fileImport.value = "";
  }
});

/* ===== tab wiring ===== */

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => setRoute(btn.dataset.route));
});

/* ===== PWA service worker ===== */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
  });
}

render();
