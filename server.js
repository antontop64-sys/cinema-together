import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
const filePath = fileURLToPath(import.meta.url);
const rooms = new Map();
const ROOM_TTL = 2 * 60 * 60 * 1000;
const PARTICIPANT_TTL = 20 * 1000;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = randomBytes(6);
  for (const value of bytes) code += alphabet[value % alphabet.length];
  return code;
}

function cleanRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [id, participant] of room.participants) {
      if (now - participant.lastSeen > PARTICIPANT_TTL) {
        room.participants.delete(id);
        pushEvent(room, "peer-left", { role: participant.role }, "server");
      }
    }
    if (!room.participants.size || now - room.createdAt > ROOM_TTL) rooms.delete(code);
  }
}

function pushEvent(room, type, data, sender, target = null) {
  const event = { id: room.nextEventId++, type, data, sender, target, at: Date.now() };
  room.events.push(event);
  if (room.events.length > 180) room.events.splice(0, room.events.length - 180);
  return event;
}

function roomSnapshot(room, participantId) {
  const me = room.participants.get(participantId);
  return {
    code: room.code,
    mode: room.mode,
    role: me?.role,
    participants: [...room.participants.values()].map(({ role, sharing, sharingAudio, micEnabled }) => ({ role, sharing, sharingAudio, micEnabled })),
    sharing: [...room.participants.values()].some((participant) => participant.role === "host" && participant.sharing)
  };
}

function roomFromPath(pathname) {
  const match = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(events|state|leave))?$/);
  if (!match) return null;
  return { code: match[1], action: match[2] || "join" };
}

async function handleApi(request, response, url) {
  cleanRooms();

  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, { ok: true, rooms: rooms.size });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(request);
    if (!["watch", "talk"].includes(body.mode) || typeof body.participantId !== "string") {
      json(response, 400, { error: "Некорректные параметры комнаты" });
      return true;
    }

    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = {
      code,
      mode: body.mode,
      createdAt: Date.now(),
      hostId: body.participantId,
      participants: new Map(),
      events: [],
      nextEventId: 1
    };
    room.participants.set(body.participantId, {
      id: body.participantId,
      role: "host",
      lastSeen: Date.now(),
      sharing: false,
      sharingAudio: false,
      micEnabled: false
    });
    rooms.set(code, room);
    json(response, 201, { room: roomSnapshot(room, body.participantId) });
    return true;
  }

  const route = roomFromPath(url.pathname);
  if (!route) return false;
  const room = rooms.get(route.code);
  if (!room) {
    json(response, 404, { error: "Комната не найдена или уже закрыта" });
    return true;
  }

  if (request.method === "POST" && route.action === "join") {
    const body = await readJson(request);
    if (typeof body.participantId !== "string") {
      json(response, 400, { error: "Не указан участник" });
      return true;
    }
    let participant = room.participants.get(body.participantId);
    if (!participant) {
      if (room.participants.size >= 2) {
        json(response, 409, { error: "В комнате уже два человека" });
        return true;
      }
      participant = { id: body.participantId, role: "guest", lastSeen: Date.now(), sharing: false, sharingAudio: false, micEnabled: false };
      room.participants.set(body.participantId, participant);
      pushEvent(room, "peer-joined", { role: "guest" }, body.participantId);
    } else {
      participant.lastSeen = Date.now();
    }
    json(response, 200, { room: roomSnapshot(room, body.participantId) });
    return true;
  }

  if (request.method === "GET" && route.action === "events") {
    const participantId = url.searchParams.get("participantId");
    const participant = room.participants.get(participantId);
    if (!participant) {
      json(response, 403, { error: "Участник больше не находится в комнате" });
      return true;
    }
    participant.lastSeen = Date.now();
    const after = Number(url.searchParams.get("after") || 0);
    const events = room.events.filter((event) => event.id > after && event.sender !== participantId && (!event.target || event.target === participantId));
    json(response, 200, { events, room: roomSnapshot(room, participantId) });
    return true;
  }

  if (request.method === "POST" && route.action === "events") {
    const body = await readJson(request);
    const participant = room.participants.get(body.participantId);
    if (!participant) {
      json(response, 403, { error: "Участник больше не находится в комнате" });
      return true;
    }
    participant.lastSeen = Date.now();
    if (typeof body.type !== "string" || body.type.length > 40) {
      json(response, 400, { error: "Некорректное событие" });
      return true;
    }
    const event = pushEvent(room, body.type, body.data ?? null, body.participantId, body.target ?? null);
    json(response, 202, { accepted: true, id: event.id });
    return true;
  }

  if (request.method === "POST" && route.action === "state") {
    const body = await readJson(request);
    const participant = room.participants.get(body.participantId);
    if (!participant) {
      json(response, 403, { error: "Участник больше не находится в комнате" });
      return true;
    }
    participant.lastSeen = Date.now();
    participant.sharing = Boolean(body.sharing);
    participant.sharingAudio = participant.sharing && Boolean(body.sharingAudio);
    participant.micEnabled = Boolean(body.micEnabled);
    pushEvent(room, "peer-state", { role: participant.role, sharing: participant.sharing, sharingAudio: participant.sharingAudio, micEnabled: participant.micEnabled }, body.participantId);
    json(response, 200, { room: roomSnapshot(room, body.participantId) });
    return true;
  }

  if (request.method === "POST" && route.action === "leave") {
    const body = await readJson(request);
    const participant = room.participants.get(body.participantId);
    if (participant) {
      room.participants.delete(body.participantId);
      pushEvent(room, "peer-left", { role: participant.role }, body.participantId);
    }
    if (!room.participants.size) rooms.delete(room.code);
    json(response, 200, { left: true });
    return true;
  }

  json(response, 405, { error: "Метод не поддерживается" });
  return true;
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  try {
    const body = await readFile(join(publicRoot, safePath));
    response.writeHead(200, {
      "content-type": mime[extname(safePath)] || "application/octet-stream",
      "cache-control": extname(safePath) === ".html" ? "no-cache" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(request, response, url);
        if (handled) return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "Метод не поддерживается" });
        return;
      }
      await serveStatic(url.pathname, response);
    } catch (error) {
      const status = error.message === "payload_too_large" ? 413 : 400;
      json(response, status, { error: status === 413 ? "Слишком большой запрос" : "Не удалось обработать запрос" });
    }
  });
}

export function resetRoomsForTests() {
  rooms.clear();
}

if (process.argv[1] === filePath) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  createServer().listen(port, host, () => console.log(`Local: http://${host}:${port}`));
}
