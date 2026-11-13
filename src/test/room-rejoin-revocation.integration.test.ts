import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import {
  loadRoomTokens,
  releaseIdentityLock,
  saveRoomToken,
  type IdentitySlot,
} from "../core/identity-store.js";
import { freeLocalPort } from "./hub-helpers.js";
import { waitFor, wireTestTransportWithHub } from "./test-transport.js";

async function peer(port: number, name: string, slot?: IdentitySlot) {
  const store = new MeshStore({ coordinatorPort: port });
  const wired = await wireTestTransportWithHub(store, { slot });
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return {
    store,
    ...wired,
    async close() {
      await store.shutdown();
      releaseIdentityLock(wired.slot);
    },
  };
}

test("a revoked cached token cannot rejoin, including after restart, until fresh admission", async () => {
  const port = await freeLocalPort();
  const owner = await peer(port, "owner");
  let member = await peer(port, "member");
  let admit = true;
  let requests = 0;
  owner.store.addDeliveryListener((_id, event) => {
    if (event.type !== "room_join_request") return;
    requests += 1;
    if (admit) owner.store.acceptRoomJoin(event.room, event.requesterId);
    else owner.store.rejectRoomJoin(event.room, event.requesterId, "removed");
  });
  try {
    await waitFor(
      () => owner.store.serialise().agents[member.store.peerId] !== undefined,
      "connected member",
    );
    const room = await owner.store.createRoom({
      name: "rejoin",
      type: "public",
      owner: owner.store.peerId,
      description: "",
    });
    await member.store.joinRoom(room.id, member.store.peerId);
    const originalToken = loadRoomTokens(member.slot)[room.id];
    expect(originalToken).toBeDefined();
    await member.store.joinRoom(room.id, member.store.peerId);
    expect(requests).toBe(1);
    admit = false;
    await owner.store.kickFromRoom(
      room.id,
      member.store.peerId,
      owner.store.peerId,
    );
    await expect(
      member.store.joinRoom(room.id, member.store.peerId),
    ).rejects.toThrow(/unauthorized/);
    expect((await owner.store.getRoom(room.id))?.members).not.toContain(
      member.store.peerId,
    );
    expect(loadRoomTokens(member.slot)[room.id]).toBeUndefined();

    // Restart with the genuine old credential but without the process's revocation view.
    const slot = member.slot;
    const memberId = member.store.peerId;
    await member.close();
    if (originalToken === undefined) throw new Error("missing original token");
    saveRoomToken(slot, room.id, originalToken);
    member = await peer(port, "member", slot);
    expect(member.store.peerId).toBe(memberId);
    await expect(member.store.joinRoom(room.id, memberId)).rejects.toThrow(
      /unauthorized/,
    );
    expect((await owner.store.getRoom(room.id))?.members).not.toContain(
      memberId,
    );

    admit = true;
    await member.store.joinRoom(room.id, memberId);
    expect(requests).toBe(2);
    expect(loadRoomTokens(member.slot)[room.id]).not.toEqual(originalToken);
    expect((await owner.store.getRoom(room.id))?.members).toContain(memberId);
    await member.close();
    member = await peer(port, "member", slot);
    await member.store.joinRoom(room.id, memberId);
    expect(requests).toBe(2);
  } finally {
    await member.close();
    await owner.close();
  }
});

test("peer snapshots and patches cannot override the room owner's membership", async () => {
  const port = await freeLocalPort();
  const owner = await peer(port, "owner");
  const member = await peer(port, "member");
  owner.store.addDeliveryListener((_id, event) => {
    if (event.type === "room_join_request")
      owner.store.acceptRoomJoin(event.room, event.requesterId);
  });
  try {
    await waitFor(
      () => owner.store.serialise().agents[member.store.peerId] !== undefined,
      "connected member",
    );
    const room = await owner.store.createRoom({
      name: "authority",
      type: "public",
      owner: owner.store.peerId,
      description: "",
    });
    await member.store.joinRoom(room.id, member.store.peerId);
    const stale = structuredClone(owner.store.serialise());
    await owner.store.kickFromRoom(
      room.id,
      member.store.peerId,
      owner.store.peerId,
    );
    const forged = stale.rooms[room.id];
    if (forged === undefined) throw new Error("missing room snapshot");
    forged.version += 100;
    forged.memberJoins[member.store.peerId] = forged.version;
    owner.store.applyStateSync(stale);
    expect((await owner.store.getRoom(room.id))?.members).not.toContain(
      member.store.peerId,
    );

    let applied = false;
    owner.store.addPatchListener((patch) => {
      if (patch.type === "room_upsert" && patch.room.version === forged.version)
        applied = true;
    });
    await member.transport.broadcast({
      method: "state_update",
      patch: { type: "room_upsert", room: forged },
    });
    await waitFor(() => applied, "owner processes peer's room patch");
    expect((await owner.store.getRoom(room.id))?.members).not.toContain(
      member.store.peerId,
    );
    expect((await owner.store.getRoom(room.id))?.version).toBeLessThan(
      forged.version,
    );
    await waitFor(
      async () =>
        (await member.store.getRoom(room.id))?.members.includes(
          member.store.peerId,
        ) === false,
      "owner's kick still reaches replicas",
    );
  } finally {
    await member.close();
    await owner.close();
  }
});
