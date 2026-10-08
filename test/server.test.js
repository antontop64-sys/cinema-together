import test from "node:test";
import assert from "node:assert/strict";
import { createServer, resetRoomsForTests } from "../server.js";

async function withServer(run) {
  resetRoomsForTests();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, path, body, method = "POST") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

test("creates a room and limits it to two people", async () => {
  await withServer(async (base) => {
    const created = await request(base, "/api/rooms", { mode: "talk", participantId: "host" });
    assert.equal(created.status, 201);
    assert.match(created.data.room.code, /^[A-Z0-9]{6}$/);
    assert.equal(created.data.room.role, "host");

    const code = created.data.room.code;
    const joined = await request(base, `/api/rooms/${code}`, { participantId: "guest" });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.room.participants.length, 2);

    const rejected = await request(base, `/api/rooms/${code}`, { participantId: "third" });
    assert.equal(rejected.status, 409);
  });
});

test("relays signaling events only to the other participant", async () => {
  await withServer(async (base) => {
    const created = await request(base, "/api/rooms", { mode: "watch", participantId: "host" });
    const code = created.data.room.code;
    await request(base, `/api/rooms/${code}`, { participantId: "guest" });
    await request(base, `/api/rooms/${code}/events`, {
      participantId: "host",
      type: "signal",
      data: { description: { type: "offer", sdp: "demo" } }
    });

    const guest = await request(base, `/api/rooms/${code}/events?participantId=guest&after=0`, null, "GET");
    assert.equal(guest.status, 200);
    assert.equal(guest.data.events.some((event) => event.type === "signal"), true);

    const host = await request(base, `/api/rooms/${code}/events?participantId=host&after=0`, null, "GET");
    assert.equal(host.data.events.some((event) => event.type === "signal"), false);
  });
});
