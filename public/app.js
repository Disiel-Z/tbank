/* Т-банк
   Локальный кошелёк + встроенный чат через Cloudflare Worker WebSocket.
*/

const STORAGE_KEY = "walletSandbox.v1";
const CHAT_STORAGE_KEY = "walletSandbox.chat.v1";
const CHAT_WS_URL = "wss://tbank.samuichatgpt.workers.dev/chat";
const CHAT_HISTORY_URL = "https://tbank.samuichatgpt.workers.dev/messages";

let chatSocket = null;
let chatConnected = false;
let chatConnecting = false;
let chatReconnectTimer = null;
let chatHistoryLoaded = false;

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function fmtMoney(n, currency = "₽") {
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
    settings: {
      haptics: false,
      chatProfile: localStorage.getItem("walletSandbox.chatProfile") || "Я"
    }
  };
  saveState(state);
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadChatMessages() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatMessages() {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages.slice(-200)));
}

function normalizeChatMessage(msg) {
  return {
    id: String(msg?.id || uid()),
    ts: String(msg?.ts || nowISO()),
    author: String(msg?.author || "Неизвестно"),
    text: String(msg?.text || "")
  };
}

function mergeChatMessages(messages) {
  const map = new Map();

  for (const item of chatMessages) {
    const normalized = normalizeChatMessage(item);
    map.set(normalized.id, normalized);
  }

  for (const item of messages) {
    const normalized = normalizeChatMessage(item);
    map.set(normalized.id, normalized);
  }

  chatMessages = Array.from(map.values())
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    .slice(-200);

  saveChatMessages();
}

let state = loadState();
let route = "accounts";
let chatMessages = loadChatMessages();

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

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getChatProfile() {
  const name = state.settings?.chatProfile || localStorage.getItem("walletSandbox.chatProfile") || "Я";
  return String(name).trim() || "Я";
}

function setChatProfile(name) {
  const safe = String(name || "").trim() || "Я";
  state.settings = state.settings || {};
  state.settings.chatProfile = safe;
  localStorage.setItem("walletSandbox.chatProfile", safe);
  saveState(state);
}

function addChatMessage(msg) {
  mergeChatMessages([msg]);

  if (route === "chat") {
    renderChatMessages();
  }
}

async function loadServerChatHistory() {
  try {
    const res = await fetch(CHAT_HISTORY_URL, { cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json();
    if (!Array.isArray(data)) return;

    mergeChatMessages(data);
    chatHistoryLoaded = true;

    if (route === "chat") {
      renderChatMessages();
    }
  } catch {
    // молча оставляем локальную историю
  }
}

function renderChatMessages() {
  const list = document.getElementById("chatList");
  if (!list) return;

  if (!chatMessages.length) {
    list.innerHTML = `<div class="note">Сообщений пока нет.</div>`;
    return;
  }

  const me = getChatProfile();

  list.innerHTML = chatMessages.map(item => {
    const ts = new Date(item.ts).toLocaleString("ru-RU", {
      dateStyle: "short",
      timeStyle: "short"
    });
    const mine = item.author === me;
    return `
      <div style="display:flex; ${mine ? "justify-content:flex-end;" : "justify-content:flex-start;"} margin-bottom:10px;">
        <div class="card" style="max-width:82%; padding:10px 12px; background:${mine ? "rgba(76,201,240,.14)" : "rgba(255,255,255,.04)"}; box-shadow:none;">
          <div class="small" style="margin-bottom:6px;"><strong>${escapeHtml(item.author)}</strong> · ${escapeHtml(ts)}</div>
          <div style="white-space:pre-wrap; word-break:break-word;">${escapeHtml(item.text)}</div>
        </div>
      </div>
    `;
  }).join("");

  list.scrollTop = list.scrollHeight;
}

function updateChatStatus() {
  const el = document.getElementById("chatStatus");
  if (!el) return;

  if (chatConnected) {
    el.textContent = "Чат подключён";
    return;
  }
  if (chatConnecting) {
    el.textContent = "Подключение к чату...";
    return;
  }
  if (!chatHistoryLoaded) {
    el.textContent = "Загрузка истории...";
    return;
  }
  el.textContent = "Чат не подключён";
}

function scheduleChatReconnect() {
  if (chatReconnectTimer) return;
  chatReconnectTimer = setTimeout(() => {
    chatReconnectTimer = null;
    connectChat();
  }, 2000);
}

function connectChat() {
  if (chatSocket && (chatSocket.readyState === WebSocket.OPEN || chatSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  chatConnecting = true;
  chatConnected = false;
  updateChatStatus();

  try {
    chatSocket = new WebSocket(CHAT_WS_URL);

    chatSocket.onopen = () => {
      chatConnecting = false;
      chatConnected = true;
      updateChatStatus();
      if (route === "chat") {
        toast("Чат подключён");
      }
    };

    chatSocket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (!parsed || !parsed.text) return;
        addChatMessage(parsed);
      } catch {
        addChatMessage({
          id: uid(),
          ts: nowISO(),
          author: "Система",
          text: String(event.data || "")
        });
      }
    };

    chatSocket.onerror = () => {
      chatConnecting = false;
      chatConnected = false;
      updateChatStatus();
    };

    chatSocket.onclose = () => {
      chatConnecting = false;
      chatConnected = false;
      updateChatStatus();
      scheduleChatReconnect();
    };
  } catch {
    chatConnecting = false;
    chatConnected = false;
    updateChatStatus();
    scheduleChatReconnect();
  }
}

function sendChatMessage() {
  const input = document.getElementById("chatInput");
  if (!input) return;

  const text = (input.value || "").trim();
  if (!text) return;

  if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) {
    toast("Чат ещё не подключён");
    connectChat();
    return;
  }

  const payload = {
    id: uid(),
    ts: nowISO(),
    author: getChatProfile(),
    text
  };

  chatSocket.send(JSON.stringify(payload));
  input.value = "";
  input.focus();
}

function render() {
  if (route === "accounts") renderAccounts();
  else if (route === "transfer") renderTransfer();
  else if (route === "activity") renderActivity();
  else if (route === "chat") renderChat();
  else if (route === "settings") renderSettings();
}

function renderAccounts() {
  const total = state.accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
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
        <div class="meta">Валюта: ${escapeHtml(a.currency)} · ID: ${a.id.slice(0, 6)}…</div>
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
  const opts = state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)} (${fmtMoney(a.balance, a.currency)})</option>`).join("");
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
      const ts = new Date(e.ts).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
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
    pushActivity({ type: "note", title: "История очищена", details: "" });
    saveState(state);
    render();
  };
}

function renderChat() {
  connectChat();
  loadServerChatHistory();

  appEl.innerHTML = `
    <section class="card">
      <div class="row">
        <div class="col">
          <div class="h1">Семейный чат</div>
          <div class="small" id="chatStatus">Загрузка истории...</div>
        </div>
        <button class="btn ghost" id="btnChatReconnect">Обновить</button>
      </div>
      <div class="hr"></div>

      <div class="grid">
        <div>
          <label>Ваше имя в чате</label>
          <input class="input" id="chatProfile" placeholder="Например: Женя" value="${escapeHtml(getChatProfile())}" />
        </div>

        <div id="chatList" class="card" style="background:rgba(255,255,255,.03); box-shadow:none; min-height:320px; max-height:50vh; overflow:auto;"></div>

        <div>
          <label>Сообщение</label>
          <textarea id="chatInput" class="input" rows="3" placeholder="Напишите сообщение..." style="resize:vertical;"></textarea>
        </div>

        <div class="grid two">
          <button class="btn primary" id="btnSendChat">Отправить</button>
          <button class="btn ghost" id="btnClearChatLocal">Очистить локально</button>
        </div>

        <div class="note">
          История теперь подтягивается с сервера. Локальный кеш на устройстве остаётся как резерв.
        </div>
      </div>
    </section>
  `;

  updateChatStatus();
  renderChatMessages();

  document.getElementById("btnChatReconnect").onclick = async () => {
    try {
      if (chatSocket) chatSocket.close();
    } catch {}
    await loadServerChatHistory();
    connectChat();
  };

  document.getElementById("chatProfile").addEventListener("change", (e) => {
    setChatProfile(e.target.value);
    toast("Имя в чате сохранено");
    renderChatMessages();
  });

  document.getElementById("btnSendChat").onclick = () => sendChatMessage();

  document.getElementById("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  document.getElementById("btnClearChatLocal").onclick = () => {
    if (!confirm("Очистить локальную историю чата на этом устройстве?")) return;
    chatMessages = [];
    saveChatMessages();
    renderChatMessages();
    toast("Локальный кеш очищен");
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
          <div class="h2">Чат</div>
          <div class="small">Имя, которое будет показываться в семейном чате</div>
          <div class="hr"></div>
          <label>Имя в чате</label>
          <input class="input" id="settingsChatProfile" value="${escapeHtml(getChatProfile())}" placeholder="Например: Женя" />
          <div style="height:10px;"></div>
          <button class="btn primary" id="btnSaveChatProfile">Сохранить имя</button>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Сброс</div>
          <div class="small">Сбросить все настройки</div>
          <div class="hr"></div>
          <button class="btn danger" id="btnReset">Сбросить всё</button>
        </div>

        <div class="note">
          <strong>Важно:</strong> версия 1.025.34 — следите за обновлениями.
        </div>
      </div>
    </section>
  `;

  document.getElementById("btnImport").onclick = () => fileImport.click();
  document.getElementById("btnExport2").onclick = () => doExport();
  document.getElementById("btnSaveChatProfile").onclick = () => {
    const val = document.getElementById("settingsChatProfile").value;
    setChatProfile(val);
    toast("Имя чата сохранено");
  };
  document.getElementById("btnReset").onclick = () => {
    if (!confirm("Сбросить данные?")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CHAT_STORAGE_KEY);
    localStorage.removeItem("walletSandbox.chatProfile");
    state = seedState();
    chatMessages = [];
    saveChatMessages();
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
    pushActivity({ type: "note", title: "Создан счёт", details: name });
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
    pushActivity({ type: "note", title: "Баланс изменён", details: acc.name });
    saveState(state);
    closeModal();
    render();
  };

  document.getElementById("mDel").onclick = () => {
    if (!confirm("Удалить счёт?")) return;
    state.accounts = state.accounts.filter(a => a.id !== accId);
    pushActivity({ type: "note", title: "Счёт удалён", details: acc.name });
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

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => setRoute(btn.dataset.route));
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

window.addEventListener("online", () => {
  loadServerChatHistory();
  connectChat();
});

window.addEventListener("focus", () => {
  if (route === "chat") {
    loadServerChatHistory();
    connectChat();
  }
});

render();
loadServerChatHistory();
connectChat();
