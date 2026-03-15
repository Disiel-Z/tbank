/* Т-банк
   Локальный кошелёк + встроенный чат через Cloudflare Worker WebSocket + Push.
   Важно:
   - импорт/экспорт кошелька = только state/accounts/activity
   - экспорт чата = только chatMessages
   - PIN хранится только локально на устройстве
   - Face ID / Touch ID в PWA реализуется через WebAuthn/passkey как локальная разблокировка
   - чат-команда: "Перевод: 5000"
     => у отправителя минус, у получателя плюс
     => защита от повторного применения по id сообщения
*/

const STORAGE_KEY = "walletSandbox.v1";
const CHAT_STORAGE_KEY = "walletSandbox.chat.v1";
const CHAT_DEVICE_USER_KEY = "walletSandbox.chatUser";
const PIN_CODE_KEY = "walletSandbox.pinCode";
const PIN_UNLOCKED_KEY = "walletSandbox.pinUnlocked";

const BIOMETRIC_ENABLED_KEY = "walletSandbox.biometricEnabled";
const BIOMETRIC_CREDENTIAL_ID_KEY = "walletSandbox.biometricCredentialId";
const BIOMETRIC_USER_ID_KEY = "walletSandbox.biometricUserId";

const PROCESSED_TRANSFER_IDS_KEY = "walletSandbox.processedTransferIds.v1";

const CHAT_WS_URL = "wss://tbank.samuichatgpt.workers.dev/chat";
const CHAT_HISTORY_URL = "https://tbank.samuichatgpt.workers.dev/messages";
const CHAT_SUBSCRIBE_URL = "https://tbank.samuichatgpt.workers.dev/subscribe";
const CHAT_VAPID_PUBLIC_KEY_URL = "https://tbank.samuichatgpt.workers.dev/vapid-public-key";
const CHAT_READ_URL = "https://tbank.samuichatgpt.workers.dev/read";

const CHAT_USERS = ["Евгения", "Андрей"];
const VALID_ROUTES = ["accounts", "transfer", "activity", "chat", "settings"];

let chatSocket = null;
let chatConnected = false;
let chatConnecting = false;
let chatReconnectTimer = null;
let chatHistoryLoaded = false;

let pushStatusText = "Уведомления не настроены";
let pushBusy = false;
let readBusy = false;
let appLocked = true;

let typingTimer = null;
let typingSent = false;
let typingAuthor = "";
let remoteTypingAuthor = "";

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
      haptics: false
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

function loadProcessedTransferIds() {
  try {
    const raw = localStorage.getItem(PROCESSED_TRANSFER_IDS_KEY);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProcessedTransferIds(ids) {
  localStorage.setItem(PROCESSED_TRANSFER_IDS_KEY, JSON.stringify(ids.slice(-500)));
}

function hasProcessedTransfer(id) {
  return processedTransferIds.includes(id);
}

function markTransferProcessed(id) {
  if (!id || hasProcessedTransfer(id)) return;
  processedTransferIds.push(id);
  processedTransferIds = processedTransferIds.slice(-500);
  saveProcessedTransferIds(processedTransferIds);
}

function normalizeChatMessage(msg) {
  return {
    id: String(msg?.id || uid()),
    ts: String(msg?.ts || nowISO()),
    author: String(msg?.author || "Неизвестно"),
    text: String(msg?.text || ""),
    status: String(msg?.status || "")
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
    const prev = map.get(normalized.id);

    map.set(normalized.id, {
      ...prev,
      ...normalized,
      status: normalized.status || prev?.status || ""
    });
  }

  chatMessages = Array.from(map.values())
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    .slice(-200);

  saveChatMessages();
  updateChatTabBadge();
}

function updateMessageStatus(messageId, status) {
  let changed = false;

  chatMessages = chatMessages.map((item) => {
    if (item.id !== messageId) return item;
    changed = true;
    return { ...item, status };
  });

  if (changed) {
    saveChatMessages();
    updateChatTabBadge();
    if (route === "chat") renderChatMessages();
  }
}

function markMessagesReadByOtherUser(reader) {
  const me = getChatProfile();
  if (!reader || !me || reader === me) return;

  let changed = false;

  chatMessages = chatMessages.map((item) => {
    if (item.author === me && item.status !== "read") {
      changed = true;
      return { ...item, status: "read" };
    }
    return item;
  });

  if (changed) {
    saveChatMessages();
    updateChatTabBadge();
    if (route === "chat") renderChatMessages();
  }
}

function getUnreadChatCount() {
  const me = getChatProfile();
  if (!me) return 0;
  return chatMessages.filter((item) => item.author !== me && item.status !== "read").length;
}

function updateChatTabBadge() {
  const chatTab = document.querySelector('.tab[data-route="chat"]');
  if (!chatTab) return;

  const textEl = chatTab.querySelector(".tab-txt");
  if (!textEl) return;

  const count = route === "chat" ? 0 : getUnreadChatCount();

  if (count <= 0) {
    textEl.innerHTML = "Чат";
    return;
  }

  const safeCount = count > 99 ? "99+" : String(count);

  textEl.innerHTML = `Чат <span style="
    display:inline-flex;
    align-items:center;
    justify-content:center;
    min-width:18px;
    height:18px;
    margin-left:6px;
    padding:0 6px;
    border-radius:999px;
    background:linear-gradient(135deg,#ff6b6b,#ff3b30);
    color:#fff;
    font-size:11px;
    font-weight:800;
    line-height:1;
    vertical-align:middle;
  ">${safeCount}</span>`;
}

function getInitialRoute() {
  const routeFromUrl = new URL(location.href).searchParams.get("route");
  if (VALID_ROUTES.includes(routeFromUrl)) return routeFromUrl;
  return "accounts";
}

let state = loadState();
let route = getInitialRoute();
let chatMessages = loadChatMessages();
let processedTransferIds = loadProcessedTransferIds();

const appEl = document.getElementById("app");
const exportBtn = document.getElementById("btnExport");
const fileImport = document.getElementById("fileImport");

const pinGateEl = document.getElementById("pinGate");
const appShellEl = document.getElementById("appShell");
const pinSetupBlockEl = document.getElementById("pinSetupBlock");
const pinUnlockBlockEl = document.getElementById("pinUnlockBlock");
const pinSetupInputEl = document.getElementById("pinSetupInput");
const pinSetupConfirmInputEl = document.getElementById("pinSetupConfirmInput");
const pinSetupErrorEl = document.getElementById("pinSetupError");
const pinSetupBtnEl = document.getElementById("pinSetupBtn");
const pinUnlockInputEl = document.getElementById("pinUnlockInput");
const pinUnlockErrorEl = document.getElementById("pinUnlockError");
const pinUnlockBtnEl = document.getElementById("pinUnlockBtn");
const pinLogoutBtnEl = document.getElementById("pinLogoutBtn");
const pinBiometricBtnEl = document.getElementById("pinBiometricBtn");
const pinBiometricHintEl = document.getElementById("pinBiometricHint");

function hasPin() {
  return !!localStorage.getItem(PIN_CODE_KEY);
}

function getPin() {
  return localStorage.getItem(PIN_CODE_KEY) || "";
}

function setPin(pin) {
  localStorage.setItem(PIN_CODE_KEY, pin);
}

function clearPin() {
  localStorage.removeItem(PIN_CODE_KEY);
  localStorage.removeItem(PIN_UNLOCKED_KEY);
  clearBiometric();
}

function setPinUnlocked(value) {
  if (value) localStorage.setItem(PIN_UNLOCKED_KEY, "1");
  else localStorage.removeItem(PIN_UNLOCKED_KEY);
}

function isPinUnlocked() {
  return localStorage.getItem(PIN_UNLOCKED_KEY) === "1";
}

function isValidPin(pin) {
  return /^\d{4,8}$/.test(pin);
}

function supportsBiometricUnlock() {
  return !!(
    window.isSecureContext &&
    window.PublicKeyCredential &&
    navigator.credentials &&
    typeof navigator.credentials.create === "function" &&
    typeof navigator.credentials.get === "function"
  );
}

function getBiometricEnabled() {
  return localStorage.getItem(BIOMETRIC_ENABLED_KEY) === "1";
}

function setBiometricEnabled(value) {
  if (value) localStorage.setItem(BIOMETRIC_ENABLED_KEY, "1");
  else localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
}

function getBiometricCredentialId() {
  return localStorage.getItem(BIOMETRIC_CREDENTIAL_ID_KEY) || "";
}

function setBiometricCredentialId(id) {
  localStorage.setItem(BIOMETRIC_CREDENTIAL_ID_KEY, id);
}

function getBiometricUserId() {
  let id = localStorage.getItem(BIOMETRIC_USER_ID_KEY);
  if (!id) {
    id = uid();
    localStorage.setItem(BIOMETRIC_USER_ID_KEY, id);
  }
  return id;
}

function clearBiometric() {
  localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
  localStorage.removeItem(BIOMETRIC_CREDENTIAL_ID_KEY);
  localStorage.removeItem(BIOMETRIC_USER_ID_KEY);
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToUint8Array(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function randomChallenge(length = 32) {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return arr;
}

function getBiometricStatusText() {
  if (!supportsBiometricUnlock()) {
    return "Face ID / Touch ID недоступен на этом устройстве или в этом режиме.";
  }
  if (!hasPin()) {
    return "Сначала нужно создать PIN.";
  }
  if (getBiometricEnabled() && getBiometricCredentialId()) {
    return "Face ID / Touch ID включён для этого устройства.";
  }
  return "Face ID / Touch ID выключен.";
}

function updateBiometricUiState() {
  if (!pinBiometricBtnEl || !pinBiometricHintEl) return;

  const enabled = getBiometricEnabled() && !!getBiometricCredentialId();
  const supported = supportsBiometricUnlock();

  pinBiometricBtnEl.style.display = enabled && supported ? "block" : "none";

  if (!supported) {
    pinBiometricHintEl.textContent = "Биометрический вход недоступен в этом браузере или режиме.";
  } else if (enabled) {
    pinBiometricHintEl.textContent = "Можно войти через Face ID / Touch ID.";
  } else {
    pinBiometricHintEl.textContent = "";
  }

  const settingsStatus = document.getElementById("biometricStatus");
  if (settingsStatus) {
    settingsStatus.textContent = getBiometricStatusText();
  }

  const settingsEnableBtn = document.getElementById("btnEnableBiometric");
  if (settingsEnableBtn) {
    settingsEnableBtn.textContent = enabled ? "Перенастроить Face ID / Touch ID" : "Включить Face ID / Touch ID";
    settingsEnableBtn.disabled = !supported || !hasPin();
  }

  const settingsDisableBtn = document.getElementById("btnDisableBiometric");
  if (settingsDisableBtn) {
    settingsDisableBtn.disabled = !(enabled && supported);
  }
}

async function registerBiometricUnlock() {
  if (!supportsBiometricUnlock()) {
    throw new Error("Face ID / Touch ID недоступен");
  }

  if (!hasPin()) {
    throw new Error("Сначала создайте PIN");
  }

  const userId = new TextEncoder().encode(getBiometricUserId());
  const challenge = randomChallenge(32);

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: "Т-банк"
      },
      user: {
        id: userId,
        name: "device-owner",
        displayName: "Владелец устройства"
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required"
      },
      timeout: 60000,
      attestation: "none"
    }
  });

  if (!credential || !credential.rawId) {
    throw new Error("Не удалось создать биометрический ключ");
  }

  setBiometricCredentialId(bufferToBase64Url(credential.rawId));
  setBiometricEnabled(true);
}

async function authenticateWithBiometric() {
  if (!supportsBiometricUnlock()) {
    throw new Error("Face ID / Touch ID недоступен");
  }

  const credentialId = getBiometricCredentialId();
  if (!credentialId || !getBiometricEnabled()) {
    throw new Error("Face ID / Touch ID не включён");
  }

  const challenge = randomChallenge(32);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [
        {
          type: "public-key",
          id: base64UrlToUint8Array(credentialId)
        }
      ],
      userVerification: "required",
      timeout: 60000
    }
  });

  if (!assertion) {
    throw new Error("Биометрическая проверка не выполнена");
  }

  unlockApp();
  toast("Вход через Face ID / Touch ID выполнен");
}

async function enableBiometricUnlock() {
  try {
    await registerBiometricUnlock();
    updateBiometricUiState();
    toast("Face ID / Touch ID включён");
  } catch (err) {
    toast(err?.message || "Не удалось включить Face ID / Touch ID");
  }
}

function disableBiometricUnlock() {
  clearBiometric();
  updateBiometricUiState();
  toast("Face ID / Touch ID отключён");
}

function showPinSetup() {
  pinGateEl.style.display = "flex";
  appShellEl.style.visibility = "hidden";
  pinSetupBlockEl.style.display = "block";
  pinUnlockBlockEl.style.display = "none";
  pinSetupErrorEl.textContent = "";
  pinSetupInputEl.value = "";
  pinSetupConfirmInputEl.value = "";
  updateBiometricUiState();
  setTimeout(() => pinSetupInputEl.focus(), 0);
}

function showPinUnlock() {
  pinGateEl.style.display = "flex";
  appShellEl.style.visibility = "hidden";
  pinSetupBlockEl.style.display = "none";
  pinUnlockBlockEl.style.display = "block";
  pinUnlockErrorEl.textContent = "";
  pinUnlockInputEl.value = "";
  updateBiometricUiState();
  setTimeout(() => pinUnlockInputEl.focus(), 0);
}

function hidePinGate() {
  pinGateEl.style.display = "none";
  appShellEl.style.visibility = "visible";
}

function unlockApp() {
  appLocked = false;
  setPinUnlocked(true);
  hidePinGate();
  afterUnlockInit();
}

function lockApp() {
  appLocked = true;
  setPinUnlocked(false);
  if (hasPin()) showPinUnlock();
  else showPinSetup();
}

function initPinFlow() {
  if (!hasPin()) {
    showPinSetup();
    return;
  }

  if (isPinUnlocked()) {
    appLocked = false;
    hidePinGate();
    afterUnlockInit();
    return;
  }

  showPinUnlock();
}

function handlePinSetup() {
  const pin = String(pinSetupInputEl.value || "").trim();
  const confirmPin = String(pinSetupConfirmInputEl.value || "").trim();

  if (!isValidPin(pin)) {
    pinSetupErrorEl.textContent = "PIN должен содержать 4–8 цифр.";
    return;
  }

  if (pin !== confirmPin) {
    pinSetupErrorEl.textContent = "PIN и подтверждение не совпадают.";
    return;
  }

  setPin(pin);
  unlockApp();
  toast("PIN сохранён");
}

function handlePinUnlock() {
  const pin = String(pinUnlockInputEl.value || "").trim();

  if (pin !== getPin()) {
    pinUnlockErrorEl.textContent = "Неверный PIN.";
    pinUnlockInputEl.value = "";
    return;
  }

  unlockApp();
}

function handlePinReset() {
  if (!confirm("Сбросить локальный PIN на этом устройстве?")) return;
  clearPin();
  showPinSetup();
}

function setRoute(r) {
  route = r;
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === r);
  });

  const url = new URL(location.href);
  if (r === "accounts") url.searchParams.delete("route");
  else url.searchParams.set("route", r);
  history.replaceState({}, "", url.toString());

  updateChatTabBadge();
  render();
}

function accountById(id) {
  return state.accounts.find((a) => a.id === id);
}

function getMainAccount() {
  return state.accounts.find((a) => String(a.name || "").trim() === "Основной кошелёк") || null;
}

function getOtherChatUser(author) {
  if (!CHAT_USERS.includes(author)) return "";
  return CHAT_USERS.find((name) => name !== author) || "";
}

function pushActivity(entry) {
  state.activity.unshift({ id: uid(), ts: nowISO(), ...entry });
}

function parseTransferCommand(text) {
  const value = String(text || "").trim();
  const match = value.match(/^Перевод:\s*([0-9]+(?:[.,][0-9]+)?)\s*$/u);
  if (!match) return null;

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return amount;
}

function applyTransferCommandFromChat(message, options = {}) {
  const silent = !!options.silent;

  const messageId = String(message?.id || "").trim();
  const author = String(message?.author || "").trim();
  const amount = parseTransferCommand(message?.text);

  if (!messageId || !author || amount === null) return false;
  if (!CHAT_USERS.includes(author)) return false;
  if (hasProcessedTransfer(messageId)) return false;

  const me = getChatProfile();
  if (!me) return false;

  const mainAccount = getMainAccount();
  if (!mainAccount) return false;

  const counterparty = getOtherChatUser(author);
  if (!counterparty) return false;

  let applied = false;

  if (author === me) {
    mainAccount.balance = Number(mainAccount.balance || 0) - amount;

    pushActivity({
      type: "expense",
      title: "Перевод",
      details: `Андрею` === counterparty ? `Андрею из чата` : `${counterparty} из чата`,
      amount,
      currency: mainAccount.currency || "₽"
    });

    applied = true;
  } else {
    mainAccount.balance = Number(mainAccount.balance || 0) + amount;

    pushActivity({
      type: "income",
      title: "Перевод",
      details: `От ${author} из чата`,
      amount,
      currency: mainAccount.currency || "₽"
    });

    applied = true;
  }

  if (!applied) return false;

  saveState(state);
  markTransferProcessed(messageId);

  if (route === "accounts" || route === "activity" || route === "transfer") {
    render();
  }

  if (!silent) {
    if (author === me) {
      toast(`Перевод отправлен: ${fmtMoney(amount, mainAccount.currency || "₽")}`);
    } else {
      toast(`Получен перевод: ${fmtMoney(amount, mainAccount.currency || "₽")}`);
    }
  }

  return true;
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
  const saved = localStorage.getItem(CHAT_DEVICE_USER_KEY);
  if (CHAT_USERS.includes(saved)) return saved;
  return "";
}

function setChatProfile(name) {
  const safe = CHAT_USERS.includes(name) ? name : "";
  if (!safe) return;
  localStorage.setItem(CHAT_DEVICE_USER_KEY, safe);
}

function ensureChatUserSelected() {
  const current = getChatProfile();
  if (current) return;

  showModal(`
    <div class="h2">Чьё это устройство?</div>
    <div class="small">Выберите пользователя один раз. Потом выбор сохранится автоматически.</div>
    <div class="hr"></div>
    <div class="grid">
      <button class="btn primary" id="pickEvgeniya">Евгения</button>
      <button class="btn primary" id="pickAndrey">Андрей</button>
    </div>
  `);

  document.getElementById("pickEvgeniya").onclick = () => {
    setChatProfile("Евгения");
    closeModal();
    updateChatTabBadge();
    render();
    toast("Устройство сохранено за пользователем: Евгения");
  };

  document.getElementById("pickAndrey").onclick = () => {
    setChatProfile("Андрей");
    closeModal();
    updateChatTabBadge();
    render();
    toast("Устройство сохранено за пользователем: Андрей");
  };
}

function addChatMessage(msg) {
  mergeChatMessages([msg]);
  applyTransferCommandFromChat(msg);

  if (route === "chat") {
    renderChatMessages();
  }
}

function updateTypingIndicator(author, isTyping) {
  const me = getChatProfile();
  if (!author || author === me) return;

  remoteTypingAuthor = isTyping ? author : "";

  const el = document.getElementById("typingIndicator");
  if (!el) return;

  if (remoteTypingAuthor) {
    el.textContent = `${remoteTypingAuthor} печатает…`;
    el.style.display = "block";
  } else {
    el.textContent = "";
    el.style.display = "none";
  }
}

function sendTypingState(isTyping) {
  const me = getChatProfile();
  if (!me) return;
  if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;

  if (typingSent === isTyping && typingAuthor === me) return;

  typingSent = isTyping;
  typingAuthor = me;

  try {
    chatSocket.send(JSON.stringify({
      type: "typing",
      author: me,
      isTyping
    }));
  } catch {}
}

function scheduleTypingStop() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    sendTypingState(false);
  }, 1200);
}

async function loadServerChatHistory() {
  try {
    const res = await fetch(CHAT_HISTORY_URL, { cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json();
    if (!Array.isArray(data)) return;

    mergeChatMessages(data);

    for (const msg of data) {
      applyTransferCommandFromChat(msg, { silent: true });
    }

    chatHistoryLoaded = true;

    if (route === "chat") {
      renderChatMessages();
      updateChatStatus();
    }
  } catch {
    // оставляем локальную историю
  }
}

async function sendReadReceipt() {
  const reader = getChatProfile();
  if (!reader || readBusy) return;

  const hasUnreadForeign = chatMessages.some(
    (item) => item.author !== reader && item.status !== "read"
  );

  if (!hasUnreadForeign) return;

  readBusy = true;

  try {
    const response = await fetch(CHAT_READ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ reader })
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok && data?.ok) {
      chatMessages = chatMessages.map((item) => {
        if (item.author !== reader) {
          return { ...item, status: "read" };
        }
        return item;
      });
      saveChatMessages();
      updateChatTabBadge();
      if (route === "chat") renderChatMessages();
    }
  } catch {
    // следующая попытка будет позже
  } finally {
    readBusy = false;
  }
}

function getOwnStatusLabel(status) {
  if (status === "read") return "Прочитано";
  if (status === "delivered") return "Доставлено";
  if (status === "sending") return "Отправляется...";
  return "";
}

function renderChatMessages() {
  const list = document.getElementById("chatList");
  if (!list) return;

  if (!chatMessages.length) {
    list.innerHTML = `<div class="note">Сообщений пока нет.</div>`;
    return;
  }

  const me = getChatProfile();

  list.innerHTML = chatMessages.map((item) => {
    const ts = new Date(item.ts).toLocaleString("ru-RU", {
      dateStyle: "short",
      timeStyle: "short"
    });

    const mine = item.author === me;
    const ownStatus = mine ? getOwnStatusLabel(item.status) : "";
    const transferAmount = parseTransferCommand(item.text);

    if (transferAmount !== null) {
      const counterparty = getOtherChatUser(item.author) || "Другой пользователь";
      const directionText = mine
        ? `${item.author} → ${counterparty}`
        : `${item.author} → ${me || counterparty}`;

      return `
        <div style="display:flex; ${mine ? "justify-content:flex-end;" : "justify-content:flex-start;"} margin-bottom:10px;">
          <div class="card" style="
            max-width:82%;
            padding:12px 14px;
            background:${mine ? "linear-gradient(135deg, rgba(76,201,240,.18), rgba(114,9,183,.16))" : "rgba(255,255,255,.05)"};
            box-shadow:none;
            border:1px solid ${mine ? "rgba(76,201,240,.28)" : "rgba(255,255,255,.10)"};
          ">
            <div class="small" style="margin-bottom:8px;">
              <strong>${escapeHtml(item.author)}</strong> · ${escapeHtml(ts)}
            </div>

            <div style="
              display:flex;
              flex-direction:column;
              gap:6px;
            ">
              <div style="
                font-size:12px;
                font-weight:800;
                letter-spacing:.08em;
                text-transform:uppercase;
                color:${mine ? "rgba(255,255,255,.82)" : "var(--muted)"};
              ">
                Перевод
              </div>

              <div style="
                font-size:24px;
                font-weight:900;
                line-height:1.1;
              ">
                ${escapeHtml(fmtMoney(transferAmount, "₽"))}
              </div>

              <div class="small" style="opacity:.92;">
                ${escapeHtml(directionText)}
              </div>
            </div>

            ${ownStatus ? `<div class="small" style="margin-top:8px; opacity:.85;">${escapeHtml(ownStatus)}</div>` : ""}
          </div>
        </div>
      `;
    }

    return `
      <div style="display:flex; ${mine ? "justify-content:flex-end;" : "justify-content:flex-start;"} margin-bottom:10px;">
        <div class="card" style="max-width:82%; padding:10px 12px; background:${mine ? "rgba(76,201,240,.14)" : "rgba(255,255,255,.04)"}; box-shadow:none;">
          <div class="small" style="margin-bottom:6px;"><strong>${escapeHtml(item.author)}</strong> · ${escapeHtml(ts)}</div>
          <div style="white-space:pre-wrap; word-break:break-word;">${escapeHtml(item.text)}</div>
          ${ownStatus ? `<div class="small" style="margin-top:6px; opacity:.85;">${escapeHtml(ownStatus)}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  list.scrollTop = list.scrollHeight;
}
  const list = document.getElementById("chatList");
  if (!list) return;

  if (!chatMessages.length) {
    list.innerHTML = `<div class="note">Сообщений пока нет.</div>`;
    return;
  }

  const me = getChatProfile();

  list.innerHTML = chatMessages.map((item) => {
    const ts = new Date(item.ts).toLocaleString("ru-RU", {
      dateStyle: "short",
      timeStyle: "short"
    });
    const mine = item.author === me;
    const ownStatus = mine ? getOwnStatusLabel(item.status) : "";

    return `
      <div style="display:flex; ${mine ? "justify-content:flex-end;" : "justify-content:flex-start;"} margin-bottom:10px;">
        <div class="card" style="max-width:82%; padding:10px 12px; background:${mine ? "rgba(76,201,240,.14)" : "rgba(255,255,255,.04)"}; box-shadow:none;">
          <div class="small" style="margin-bottom:6px;"><strong>${escapeHtml(item.author)}</strong> · ${escapeHtml(ts)}</div>
          <div style="white-space:pre-wrap; word-break:break-word;">${escapeHtml(item.text)}</div>
          ${ownStatus ? `<div class="small" style="margin-top:6px; opacity:.85;">${escapeHtml(ownStatus)}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  list.scrollTop = list.scrollHeight;
}

function updateChatStatus() {
  const el = document.getElementById("chatStatus");
  if (!el) return;

  const me = getChatProfile();

  if (!me) {
    el.textContent = "Выберите пользователя для этого устройства";
    return;
  }

  if (chatConnected) {
    el.textContent = `Чат подключён · Вы: ${me}`;
    return;
  }
  if (chatConnecting) {
    el.textContent = `Подключение к чату... · Вы: ${me}`;
    return;
  }
  if (!chatHistoryLoaded) {
    el.textContent = `Загрузка истории... · Вы: ${me}`;
    return;
  }
  el.textContent = `Чат не подключён · Вы: ${me}`;
}

function updatePushStatusText(text) {
  pushStatusText = text;

  const a = document.getElementById("pushStatus");
  const b = document.getElementById("settingsPushStatus");

  if (a) a.textContent = text;
  if (b) b.textContent = text;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function ensureServiceWorkerReady() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker не поддерживается");
  }

  return navigator.serviceWorker.ready;
}

async function refreshPushStatus() {
  try {
    if (!("Notification" in window)) {
      updatePushStatusText("Уведомления не поддерживаются");
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      updatePushStatusText("Push не поддерживается");
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      updatePushStatusText("Уведомления включены");
      return;
    }

    if (Notification.permission === "denied") {
      updatePushStatusText("Доступ к уведомлениям запрещён");
      return;
    }

    if (Notification.permission === "granted") {
      updatePushStatusText("Разрешение выдано, подписка не завершена");
      return;
    }

    updatePushStatusText("Уведомления выключены");
  } catch {
    updatePushStatusText("Статус уведомлений недоступен");
  }
}

async function enablePushNotifications() {
  if (pushBusy) return;

  const me = getChatProfile();
  if (!me) {
    toast("Сначала выберите пользователя");
    ensureChatUserSelected();
    return;
  }

  pushBusy = true;
  updatePushStatusText("Настройка уведомлений...");

  try {
    if (!("Notification" in window)) {
      throw new Error("Уведомления не поддерживаются");
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("Push не поддерживается");
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Разрешение на уведомления не выдано");
    }

    const registration = await ensureServiceWorkerReady();

    let vapidPublicKey = await fetch(CHAT_VAPID_PUBLIC_KEY_URL, { cache: "no-store" }).then((r) => r.text());
    vapidPublicKey = String(vapidPublicKey || "").trim();

    if (!vapidPublicKey) {
      throw new Error("Публичный push-ключ пустой");
    }

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }

    const response = await fetch(CHAT_SUBSCRIBE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        user: me,
        subscription
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "Не удалось сохранить подписку");
    }

    updatePushStatusText("Уведомления включены");
    toast("Уведомления включены");
  } catch (err) {
    updatePushStatusText(err?.message || "Не удалось включить уведомления");
    toast(err?.message || "Не удалось включить уведомления");
  } finally {
    pushBusy = false;
  }
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

        if (parsed?.type === "ack" && parsed?.id) {
          updateMessageStatus(parsed.id, parsed.status || "delivered");
          return;
        }

        if (parsed?.type === "read" && parsed?.reader) {
          markMessagesReadByOtherUser(parsed.reader);
          return;
        }

        if (parsed?.type === "typing" && parsed?.author) {
          updateTypingIndicator(parsed.author, !!parsed.isTyping);
          return;
        }

        if (parsed?.type === "message" && parsed?.text) {
          addChatMessage(parsed);
          updateTypingIndicator(parsed.author, false);
          if (route === "chat") {
            sendReadReceipt();
          }
          return;
        }

        if (parsed?.text) {
          addChatMessage(parsed);
          if (route === "chat") {
            sendReadReceipt();
          }
        }
      } catch {
        addChatMessage({
          id: uid(),
          ts: nowISO(),
          author: "Система",
          text: String(event.data || ""),
          status: ""
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

  const me = getChatProfile();
  if (!me) {
    toast("Сначала выберите пользователя");
    ensureChatUserSelected();
    return;
  }

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
    author: me,
    text,
    status: "sending"
  };

  clearTimeout(typingTimer);
  sendTypingState(false);
  updateTypingIndicator(me, false);

  addChatMessage(payload);
  chatSocket.send(JSON.stringify(payload));
  input.value = "";
  input.focus();
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

function doChatExportJSON() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Т-банк",
    chat: {
      participants: CHAT_USERS,
      messages: chatMessages
    }
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replaceAll(":", "-");
  a.href = url;
  a.download = `tbank-chat-export-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function render() {
  if (appLocked) return;

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
  list.innerHTML = state.accounts.map((a) => `
    <div class="item" data-id="${a.id}">
      <div class="left">
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="meta">Валюта: ${escapeHtml(a.currency)} · ID: ${a.id.slice(0, 6)}…</div>
      </div>
      <div class="amt">${fmtMoney(a.balance, a.currency)}</div>
    </div>
  `).join("");

  document.getElementById("btnAddAccount").onclick = () => modalAddAccount();
  document.querySelectorAll(".item[data-id]").forEach((el) => {
    el.onclick = () => modalEditBalance(el.dataset.id);
  });
}

function renderTransfer() {
  const opts = state.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${fmtMoney(a.balance, a.currency)})</option>`).join("");
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
    list.innerHTML = state.activity.map((e) => {
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
  loadServerChatHistory().then(() => {
    sendReadReceipt();
  });

  const currentUser = getChatProfile();

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
          <label>Это устройство принадлежит</label>
          <select id="chatProfile" class="input">
            <option value="">Выберите пользователя</option>
            ${CHAT_USERS.map((name) => `<option value="${escapeHtml(name)}" ${currentUser === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
          </select>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Уведомления</div>
          <div class="small" id="pushStatus">${escapeHtml(pushStatusText)}</div>
          <div class="hr"></div>
          <button class="btn primary" id="btnEnablePush">Включить уведомления</button>
        </div>

        <div id="chatList" class="card" style="background:rgba(255,255,255,.03); box-shadow:none; min-height:320px; max-height:50vh; overflow:auto;"></div>

        <div id="typingIndicator" class="small" style="display:${remoteTypingAuthor ? "block" : "none"}; min-height:18px; opacity:.82; margin-top:-4px; margin-bottom:4px;">
          ${remoteTypingAuthor ? `${escapeHtml(remoteTypingAuthor)} печатает…` : ""}
        </div>

        <div>
          <label>Сообщение</label>
          <textarea id="chatInput" class="input" rows="3" placeholder="Напишите сообщение..." style="resize:vertical;"></textarea>
        </div>

        <div class="grid">
          <div class="grid two">
            <button class="btn primary" id="btnSendChat">Отправить</button>
            <button class="btn ghost" id="btnClearChatLocal">Очистить локально</button>
          </div>
          <button class="btn ghost" id="btnExportChat">Экспорт чата JSON</button>
        </div>

        <div class="note">
          Команда перевода: <strong>Перевод: 5000</strong>
        </div>
      </div>
    </section>
  `;

  updateChatStatus();
  renderChatMessages();
  updateChatTabBadge();

  document.getElementById("btnChatReconnect").onclick = async () => {
    try {
      if (chatSocket) chatSocket.close();
    } catch {}
    await loadServerChatHistory();
    connectChat();
    await sendReadReceipt();
  };

  document.getElementById("chatProfile").addEventListener("change", (e) => {
    setChatProfile(e.target.value);
    updateChatStatus();
    renderChatMessages();
    updateChatTabBadge();
    toast("Пользователь устройства сохранён");
    sendReadReceipt();
  });

  document.getElementById("btnEnablePush").onclick = () => enablePushNotifications();
  document.getElementById("btnExportChat").onclick = () => doChatExportJSON();
  document.getElementById("btnSendChat").onclick = () => sendChatMessage();

  const chatInput = document.getElementById("chatInput");
  chatInput.addEventListener("input", () => {
    const value = String(chatInput.value || "").trim();

    if (!value) {
      clearTimeout(typingTimer);
      sendTypingState(false);
      return;
    }

    sendTypingState(true);
    scheduleTypingStop();
  });

  chatInput.addEventListener("blur", () => {
    clearTimeout(typingTimer);
    sendTypingState(false);
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  document.getElementById("btnClearChatLocal").onclick = () => {
    if (!confirm("Очистить локальную историю чата на этом устройстве?")) return;
    chatMessages = [];
    saveChatMessages();
    updateChatTabBadge();
    renderChatMessages();
    toast("Локальный кеш очищен");
  };
}

function renderSettings() {
  const currentUser = getChatProfile();

  appEl.innerHTML = `
    <section class="card">
      <div class="h1">Настройки</div>
      <div class="small">Параметры приложения</div>
      <div class="hr"></div>

      <div class="grid">
        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Импорт / Экспорт</div>
          <div class="small">Перенос данных приложения и отдельный экспорт переписки</div>
          <div class="hr"></div>
          <div class="grid">
            <div class="grid two">
              <button class="btn" id="btnImport">Импорт</button>
              <button class="btn" id="btnExport2">Экспорт кошелька</button>
            </div>
            <button class="btn ghost" id="btnExportChatFromSettings">Экспорт чата JSON</button>
          </div>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Пользователь чата</div>
          <div class="small">Кто использует это устройство</div>
          <div class="hr"></div>
          <label>Выберите пользователя</label>
          <select class="input" id="settingsChatProfile">
            <option value="">Выберите пользователя</option>
            ${CHAT_USERS.map((name) => `<option value="${escapeHtml(name)}" ${currentUser === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
          </select>
          <div style="height:10px;"></div>
          <button class="btn primary" id="btnSaveChatProfile">Сохранить</button>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Уведомления</div>
          <div class="small" id="settingsPushStatus">${escapeHtml(pushStatusText)}</div>
          <div class="hr"></div>
          <button class="btn primary" id="btnEnablePushFromSettings">Включить уведомления</button>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Биометрия</div>
          <div class="small" id="biometricStatus">${escapeHtml(getBiometricStatusText())}</div>
          <div class="hr"></div>
          <div class="grid two">
            <button class="btn primary" id="btnEnableBiometric">Включить Face ID / Touch ID</button>
            <button class="btn ghost" id="btnDisableBiometric">Отключить</button>
          </div>
        </div>

        <div class="card" style="background: rgba(255,255,255,.03); box-shadow:none;">
          <div class="h2">Безопасность</div>
          <div class="small">Локальная защита PIN-кодом на этом устройстве</div>
          <div class="hr"></div>
          <button class="btn danger" id="btnResetPin">Сбросить локальный PIN</button>
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
  document.getElementById("btnExportChatFromSettings").onclick = () => doChatExportJSON();

  document.getElementById("btnSaveChatProfile").onclick = () => {
    const val = document.getElementById("settingsChatProfile").value;
    setChatProfile(val);
    updateChatTabBadge();
    toast("Пользователь устройства сохранён");
  };

  document.getElementById("btnEnablePushFromSettings").onclick = () => enablePushNotifications();
  document.getElementById("btnEnableBiometric").onclick = () => enableBiometricUnlock();
  document.getElementById("btnDisableBiometric").onclick = () => disableBiometricUnlock();

  document.getElementById("btnResetPin").onclick = () => {
    if (!confirm("Сбросить локальный PIN на этом устройстве?")) return;
    clearPin();
    lockApp();
  };

  document.getElementById("btnReset").onclick = () => {
    if (!confirm("Сбросить данные?")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CHAT_STORAGE_KEY);
    localStorage.removeItem(CHAT_DEVICE_USER_KEY);
    localStorage.removeItem(PROCESSED_TRANSFER_IDS_KEY);
    state = seedState();
    chatMessages = [];
    processedTransferIds = [];
    remoteTypingAuthor = "";
    saveChatMessages();
    updateChatTabBadge();
    toast("Сброшено");
    render();
    setTimeout(() => {
      ensureChatUserSelected();
    }, 0);
  };

  updateBiometricUiState();
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
    state.accounts = state.accounts.filter((a) => a.id !== accId);
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

function afterUnlockInit() {
  render();
  loadServerChatHistory();
  connectChat();
  refreshPushStatus();
  updateBiometricUiState();
  updateChatTabBadge();

  setTimeout(() => {
    ensureChatUserSelected();
    updateChatTabBadge();
    if (route === "chat") {
      sendReadReceipt();
    }
  }, 0);
}

pinSetupBtnEl.onclick = () => handlePinSetup();
pinUnlockBtnEl.onclick = () => handlePinUnlock();
pinLogoutBtnEl.onclick = () => handlePinReset();
pinBiometricBtnEl.onclick = () => {
  authenticateWithBiometric().catch((err) => {
    toast(err?.message || "Не удалось выполнить вход через Face ID / Touch ID");
  });
};

pinSetupInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pinSetupConfirmInputEl.focus();
});
pinSetupConfirmInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handlePinSetup();
});
pinUnlockInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handlePinUnlock();
});

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
    setRoute("accounts");
  } catch {
    toast("Не удалось импортировать JSON");
  } finally {
    fileImport.value = "";
  }
});

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => setRoute(btn.dataset.route));
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

window.addEventListener("online", () => {
  if (appLocked) return;
  loadServerChatHistory();
  connectChat();
  refreshPushStatus();
  updateChatTabBadge();
  if (route === "chat") sendReadReceipt();
});

window.addEventListener("focus", () => {
  if (appLocked) return;
  if (route === "chat") {
    loadServerChatHistory().then(() => {
      sendReadReceipt();
    });
    connectChat();
  }
  refreshPushStatus();
  updateChatTabBadge();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    setPinUnlocked(false);
  }
});

window.addEventListener("beforeunload", () => {
  setPinUnlocked(false);
});

initPinFlow();