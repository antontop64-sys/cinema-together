const $ = (selector) => document.querySelector(selector);
const modeButtons = [...document.querySelectorAll("[data-mode]")];
const setupView = $("#setup-view");
const roomView = $("#room-view");
const createButton = $("#create-room");
const joinForm = $("#join-form");
const roomInput = $("#room-code");
const setupError = $("#setup-error");
const remoteVideo = $("#remote-video");
const remoteAudio = $("#remote-audio");
const localPreview = $("#local-preview");
const shareButton = $("#share-button");
const micButton = $("#mic-button");
const leaveButton = $("#leave-button");

let selectedMode = "watch";
let room = null;
let role = null;
let participantId = crypto.randomUUID();
let lastEventId = 0;
let polling = false;
let peer = null;
let screenStream = null;
let micStream = null;
let remoteStream = new MediaStream();
let makingOffer = false;
let pendingCandidates = [];
let reconnectTimer = null;
let toastTimer = null;

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Что-то пошло не так");
  return payload;
};

function setSetupError(message = "") {
  setupError.textContent = message;
  setupError.hidden = !message;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
}

function setConnection(text, state = "waiting") {
  const badge = $("#connection-badge");
  badge.dataset.state = state;
  badge.querySelector("strong").textContent = text;
}

function setStage(title, copy) {
  $("#stage-title").textContent = title;
  $("#stage-copy").textContent = copy;
}

for (const button of modeButtons) {
  button.addEventListener("click", () => {
    selectedMode = button.dataset.mode;
    for (const option of modeButtons) {
      const selected = option === button;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-checked", String(selected));
    }
  });
}

roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  setSetupError();
});

createButton.addEventListener("click", async () => {
  createButton.disabled = true;
  setSetupError();
  try {
    await createRoom(selectedMode);
  } catch (error) {
    setSetupError(error.message);
  } finally {
    createButton.disabled = false;
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (roomInput.value.length !== 6) return setSetupError("Введите шестизначный код комнаты");
  await joinRoom(roomInput.value).catch(() => {});
});

async function createRoom(mode) {
  if (room) throw new Error("Сначала выйдите из текущей комнаты");
  if (!["watch", "talk"].includes(mode)) throw new Error("Неизвестный режим комнаты");
  const result = await api("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ mode, participantId })
  });
  enterRoom(result.room);
  return result.room;
}

async function joinRoom(code) {
  if (room) throw new Error("Сначала выйдите из текущей комнаты");
  setSetupError();
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(code)}`, {
      method: "POST",
      body: JSON.stringify({ participantId })
    });
    enterRoom(result.room);
    return result.room;
  } catch (error) {
    setSetupError(error.message);
    history.replaceState({}, "", location.pathname);
    throw error;
  }
}

function enterRoom(nextRoom) {
  room = nextRoom;
  role = nextRoom.role;
  lastEventId = 0;
  setupView.hidden = true;
  roomView.hidden = false;
  $("#room-code-label").textContent = room.code;
  $("#room-mode-label").textContent = room.mode === "talk" ? "Смотреть и общаться" : "Смотреть вместе";
  $("#self-role").textContent = role === "host" ? "Организатор" : "Гость";
  micButton.hidden = room.mode !== "talk";
  shareButton.hidden = role !== "host";
  $("#status-list").firstElementChild.textContent = role === "host" ? "Комната создана" : "Вы вошли в комнату";
  const invite = `${location.origin}${location.pathname}?room=${room.code}`;
  $("#invite-link").textContent = invite.replace(/^https?:\/\//, "");
  $("#copy-link").dataset.link = invite;
  history.replaceState({}, "", `?room=${room.code}`);
  updateRoomState(room);
  if (role === "guest") setStage("Ждём трансляцию", "Организатор запустит показ экрана, когда будет готов.");
  polling = true;
  pollEvents();
}

function updateRoomState(snapshot) {
  const peerPresent = snapshot.participants.length > 1;
  $("#people-count").textContent = `${snapshot.participants.length}/2`;
  $("#peer-row").querySelector(".avatar").classList.toggle("is-muted", !peerPresent);
  $("#peer-detail").textContent = peerPresent ? (role === "host" ? "Гость" : "Организатор") : "Ещё не вошёл";
  $("#peer-state").textContent = peerPresent ? "Онлайн" : "Ожидание";
  $("#peer-state").classList.toggle("is-online", peerPresent);
  $("#status-peer").textContent = peerPresent ? "Второй участник подключён" : "Ожидаем второго участника";
  $("#status-peer").className = peerPresent ? "is-complete" : "is-active";
  $("#status-media").textContent = snapshot.sharing ? "Трансляция запущена" : "Трансляция ещё не запущена";
  $("#status-media").className = snapshot.sharing ? "is-complete" : "";

  if (!peerPresent) {
    setConnection("Ожидаем участника", "waiting");
    if (peer) closePeer();
  } else if (!peer || ["new", "connecting"].includes(peer.connectionState)) {
    setConnection("Соединяем", "waiting");
  }

  if (role === "host" && peerPresent && !peer) {
    ensurePeer();
    createOffer();
  }
}

async function pollEvents() {
  if (!polling || !room) return;
  try {
    const result = await api(`/api/rooms/${room.code}/events?participantId=${encodeURIComponent(participantId)}&after=${lastEventId}`, { headers: {} });
    room = result.room;
    updateRoomState(room);
    for (const event of result.events) {
      lastEventId = Math.max(lastEventId, event.id);
      await handleEvent(event);
    }
    setTimeout(pollEvents, 650);
  } catch {
    setConnection("Восстанавливаем связь", "error");
    setTimeout(pollEvents, 1800);
  }
}

async function sendEvent(type, data = null) {
  if (!room) return;
  await api(`/api/rooms/${room.code}/events`, {
    method: "POST",
    body: JSON.stringify({ participantId, type, data })
  });
}

async function sendState() {
  if (!room) return;
  const result = await api(`/api/rooms/${room.code}/state`, {
    method: "POST",
    body: JSON.stringify({
      participantId,
      sharing: Boolean(screenStream),
      micEnabled: Boolean(micStream?.getAudioTracks().some((track) => track.enabled))
    })
  });
  room = result.room;
}

async function handleEvent(event) {
  if (event.type === "peer-joined") {
    updateRoomState(room);
    if (role === "host") {
      ensurePeer();
      await createOffer();
    }
  }
  if (event.type === "peer-left") {
    closePeer();
    setConnection("Ожидаем участника", "waiting");
    showToast("Второй участник вышел");
  }
  if (event.type === "signal") await handleSignal(event.data);
  if (event.type === "renegotiate" && role === "host") await createOffer();
  if (event.type === "peer-state") {
    const detail = event.data.micEnabled ? "Микрофон включён" : (event.data.sharing ? "Показывает экран" : "Онлайн");
    $("#peer-detail").textContent = detail;
  }
}

function ensurePeer() {
  if (peer && peer.connectionState !== "closed") return peer;
  peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  remoteStream = new MediaStream();

  peer.onicecandidate = ({ candidate }) => {
    if (candidate) sendEvent("signal", { candidate }).catch(() => {});
  };
  if (role === "host") {
    peer.createDataChannel("presence");
  } else {
    peer.ondatachannel = ({ channel }) => {
      channel.onmessage = () => {};
    };
  }
  peer.ontrack = ({ track }) => {
    if (!remoteStream.getTracks().some((item) => item.id === track.id)) remoteStream.addTrack(track);
    if (role === "guest") {
      remoteVideo.srcObject = remoteStream;
      if (track.kind === "video") {
        remoteVideo.dataset.active = "true";
        $("#stage-empty").hidden = true;
        $("#live-label").hidden = false;
      }
    } else {
      remoteAudio.srcObject = remoteStream;
    }
  };
  peer.onconnectionstatechange = () => {
    if (!peer) return;
    if (peer.connectionState === "connected") {
      clearTimeout(reconnectTimer);
      setConnection("Подключено", "connected");
    } else if (peer.connectionState === "failed") {
      setConnection("Восстанавливаем связь", "error");
      if (role === "host") createOffer(true);
      else sendEvent("renegotiate").catch(() => {});
    } else if (peer.connectionState === "disconnected") {
      setConnection("Связь прервана", "error");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (role === "host") createOffer(true);
        else sendEvent("renegotiate").catch(() => {});
      }, 3000);
    }
  };

  for (const track of screenStream?.getTracks() || []) peer.addTrack(track, screenStream);
  for (const track of micStream?.getTracks() || []) peer.addTrack(track, micStream);
  return peer;
}

async function createOffer(restartIce = false) {
  if (role !== "host" || makingOffer || !room || room.participants.length < 2) return;
  try {
    makingOffer = true;
    const pc = ensurePeer();
    if (restartIce && pc.restartIce) pc.restartIce();
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: restartIce }));
    await sendEvent("signal", { description: pc.localDescription });
  } catch {
    setConnection("Не удалось соединиться", "error");
  } finally {
    makingOffer = false;
  }
}

async function handleSignal(signal) {
  const pc = ensurePeer();
  try {
    if (signal.description) {
      if (signal.description.type === "offer") {
        await pc.setRemoteDescription(signal.description);
        for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
        await pc.setLocalDescription(await pc.createAnswer());
        await sendEvent("signal", { description: pc.localDescription });
      } else if (signal.description.type === "answer") {
        await pc.setRemoteDescription(signal.description);
        for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      }
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else pendingCandidates.push(signal.candidate);
    }
  } catch {
    setConnection("Повторяем подключение", "error");
  }
}

shareButton.addEventListener("click", async () => {
  if (screenStream) return stopSharing();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    localPreview.srcObject = screenStream;
    localPreview.hidden = false;
    shareButton.classList.add("is-live");
    shareButton.querySelector("span:last-child").textContent = "Остановить показ";
    $("#live-label").hidden = false;
    setStage("Экран показывается", "Второй участник видит выбранную вкладку или окно.");
    for (const track of screenStream.getTracks()) {
      ensurePeer().addTrack(track, screenStream);
      track.addEventListener("ended", stopSharing, { once: true });
    }
    await sendState();
    await createOffer();
  } catch (error) {
    if (error.name !== "NotAllowedError") showToast("Не удалось начать показ экрана");
  }
});

async function stopSharing() {
  if (!screenStream) return;
  const oldStream = screenStream;
  screenStream = null;
  for (const track of oldStream.getTracks()) {
    const sender = peer?.getSenders().find((item) => item.track === track);
    if (sender && peer) peer.removeTrack(sender);
    track.stop();
  }
  localPreview.srcObject = null;
  localPreview.hidden = true;
  shareButton.classList.remove("is-live");
  shareButton.querySelector("span:last-child").textContent = "Показать экран";
  $("#live-label").hidden = true;
  setStage("Показ остановлен", "Можно выбрать другой экран или вкладку и продолжить.");
  await sendState().catch(() => {});
  await createOffer();
}

micButton.addEventListener("click", async () => {
  const activeTrack = micStream?.getAudioTracks()[0];
  if (activeTrack) {
    activeTrack.enabled = !activeTrack.enabled;
    setMicUi(activeTrack.enabled);
    await sendState().catch(() => {});
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    for (const track of micStream.getTracks()) ensurePeer().addTrack(track, micStream);
    setMicUi(true);
    await sendState();
    if (role === "host") await createOffer(); else await sendEvent("renegotiate");
  } catch (error) {
    if (error.name === "NotAllowedError") showToast("Разрешение на микрофон не получено");
    else showToast("Микрофон недоступен");
  }
});

function setMicUi(enabled) {
  micButton.setAttribute("aria-pressed", String(enabled));
  micButton.querySelector("span:last-child").textContent = enabled ? "Выключить микрофон" : "Включить микрофон";
  micButton.querySelector(".control-icon").textContent = enabled ? "●" : "○";
}

$("#copy-link").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(event.currentTarget.dataset.link);
    event.currentTarget.textContent = "Скопировано";
    setTimeout(() => { event.currentTarget.textContent = "Копировать"; }, 1700);
  } catch {
    showToast("Скопируйте ссылку из адресной строки");
  }
});

leaveButton.addEventListener("click", leaveRoom);

async function leaveRoom() {
  polling = false;
  const oldRoom = room;
  closePeer();
  for (const track of screenStream?.getTracks() || []) track.stop();
  for (const track of micStream?.getTracks() || []) track.stop();
  screenStream = null;
  micStream = null;
  if (oldRoom) {
    await api(`/api/rooms/${oldRoom.code}/leave`, { method: "POST", body: JSON.stringify({ participantId }) }).catch(() => {});
  }
  room = null;
  role = null;
  participantId = crypto.randomUUID();
  remoteVideo.srcObject = null;
  remoteVideo.removeAttribute("data-active");
  roomView.hidden = true;
  setupView.hidden = false;
  history.replaceState({}, "", location.pathname);
}

function closePeer() {
  clearTimeout(reconnectTimer);
  peer?.close();
  peer = null;
  pendingCandidates = [];
  remoteStream = new MediaStream();
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
  remoteVideo.removeAttribute("data-active");
  $("#stage-empty").hidden = false;
  if (role === "guest") setStage("Ждём трансляцию", "Организатор запустит показ экрана, когда будет готов.");
}

window.addEventListener("beforeunload", () => {
  if (room) navigator.sendBeacon(`/api/rooms/${room.code}/leave`, new Blob([JSON.stringify({ participantId })], { type: "application/json" }));
});

const linkedRoom = new URLSearchParams(location.search).get("room")?.toUpperCase();
if (linkedRoom && /^[A-Z0-9]{6}$/.test(linkedRoom)) {
  roomInput.value = linkedRoom;
  joinRoom(linkedRoom).catch(() => {});
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const signal = new AbortController().signal;
  const register = (tool) => Promise.resolve(context.registerTool(tool, { signal })).catch(() => {});

  register({
    name: "create_room",
    title: "Создать комнату",
    description: "Создаёт новую приватную комнату для двух человек и открывает её на странице.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["watch", "talk"], description: "watch — только просмотр; talk — просмотр с микрофонами" } },
      required: ["mode"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const created = await createRoom(input?.mode);
      return { code: created.code, mode: created.mode, inviteUrl: `${location.origin}${location.pathname}?room=${created.code}` };
    }
  });

  register({
    name: "join_room",
    title: "Войти в комнату",
    description: "Входит в существующую комнату по шестизначному коду и обновляет страницу комнаты.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^[A-Za-z0-9]{6}$" } },
      required: ["code"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const code = String(input?.code || "").toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Нужен шестизначный код комнаты");
      const joined = await joinRoom(code);
      return { code: joined.code, mode: joined.mode, role: joined.role };
    }
  });

  register({
    name: "get_room_status",
    title: "Статус комнаты",
    description: "Возвращает текущий код, режим, роль и число участников без изменения комнаты.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      return room ? { code: room.code, mode: room.mode, role, participants: room.participants.length, sharing: room.sharing } : { active: false };
    }
  });
}

registerWebMcpTools();
