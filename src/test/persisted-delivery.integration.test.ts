import { expect, test } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { dmRoomPath } from "../core/room-path.js";
import { loadOrCreateIdentity, saveRoomToken } from "../core/identity-store.js";
import { toIdentityPort } from "../core/wire-mesh-identity.js";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import type { DeliveryEvent } from "../core/types.js";
import { freeLocalPort } from "./hub-helpers.js";
import { scratchDirectory } from "./scratch-directory.helper.js";
import { FileReceipts } from "./persisted-delivery.helper.js";
import { wireTestTransport, waitFor } from "./test-transport.js";

const TOKEN_TTL_MS = 60_000;
const MESSAGE_ID_BYTES = 16;

test("real peers report persisted acceptance and deduplicate across receiver recreation", async () => {
  const port = await freeLocalPort();
  const directory = scratchDirectory("persisted-receipts-");
  const sender = new MeshStore({ coordinatorPort: port });
  let receiver = new MeshStore({
    coordinatorPort: port,
    deliveryPersistence: new FileReceipts(directory),
  });
  const senderSlot = await wireTestTransport(sender);
  const receiverSlot = await wireTestTransport(receiver);
  const deliveries: DeliveryEvent[] = [];
  const directDeliveries: DeliveryEvent[] = [];
  try {
    await sender.init();
    await receiver.init();
    for (const [store, name] of [
      [sender, "sender"],
      [receiver, "receiver"],
    ] as const) {
      await store.registerAgent({
        name,
        harness: "test",
        cwd: "/fixture",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });
    }
    await waitFor(
      () => sender.serialise().agents[receiver.peerId] !== undefined,
      "sender sees receiver",
    );
    const room = await sender.createRoom({
      name: "persisted",
      owner: sender.peerId,
      type: "public",
      description: "",
    });
    await sender.joinRoom(room.id, receiver.peerId);
    const identity = await toIdentityPort(loadOrCreateIdentity(senderSlot));
    const clock = createSystemClock();
    const grant = await mintCapabilityToken({
      identity,
      clock,
      tokenId: new Uint8Array([1]),
      bearer: deviceIdFromHex(receiver.peerId),
      capability: "room:member",
      scope: { kind: "room", path: room.id },
      expires: clock.now() + TOKEN_TTL_MS,
      delegationsRemaining: 0,
    });
    if (!grant.ok) throw new Error("Could not mint fixture membership");
    saveRoomToken(receiverSlot, room.id, grant.token);
    await waitFor(
      async () =>
        (await sender.getRoom(room.id))?.members.includes(receiver.peerId) ===
        true,
      "room membership synchronized",
    );
    receiver.onDelivery = (_id, event) => {
      if (event.type === "room_message") deliveries.push(event);
      if (event.type === "dm") directDeliveries.push(event);
    };
    const options = {
      messageId: "ab".repeat(MESSAGE_ID_BYTES),
      requirePersistence: true,
    };
    const first = await sender.sendRoomMessage(
      room.id,
      sender.peerId,
      "durable hello",
      options,
    );
    expect(first.deliveries).toContainEqual({
      member: receiver.peerId,
      delivery: { status: "delivered", persisted: true },
    });
    expect(deliveries).toHaveLength(1);
    await sender.sendRoomMessage(
      room.id,
      sender.peerId,
      "durable hello",
      options,
    );
    expect(deliveries).toHaveLength(1);
    const dmPath = dmRoomPath(sender.peerId, receiver.peerId);
    const recipientIdentity = await toIdentityPort(
      loadOrCreateIdentity(receiverSlot),
    );
    const dmGrant = await mintCapabilityToken({
      identity: recipientIdentity,
      clock,
      tokenId: new Uint8Array([2]),
      bearer: deviceIdFromHex(sender.peerId),
      capability: "room:member",
      scope: { kind: "room", path: dmPath },
      expires: clock.now() + TOKEN_TTL_MS,
      delegationsRemaining: 0,
    });
    if (!dmGrant.ok) throw new Error("Could not mint fixture DM grant");
    saveRoomToken(senderSlot, dmPath, dmGrant.token);
    const direct = await sender.sendDm(
      sender.peerId,
      receiver.peerId,
      "persisted DM",
      options,
    );
    expect(direct.delivery).toEqual({ status: "delivered", persisted: true });
    expect(directDeliveries).toHaveLength(1);
    await receiver.shutdown();
    receiver = new MeshStore({
      coordinatorPort: port,
      deliveryPersistence: new FileReceipts(directory),
    });
    await wireTestTransport(receiver, { slot: receiverSlot });
    receiver.onDelivery = (_id, event) => {
      if (event.type === "room_message") deliveries.push(event);
      if (event.type === "dm") directDeliveries.push(event);
    };
    await receiver.init();
    await receiver.registerAgent({
      name: "receiver",
      harness: "test",
      cwd: "/fixture",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    await waitFor(() => receiver.connected, "receiver reconnects");
    const repeated = await sender.sendRoomMessage(
      room.id,
      sender.peerId,
      "durable hello",
      options,
    );
    expect(repeated.deliveries).toContainEqual({
      member: receiver.peerId,
      delivery: { status: "delivered", persisted: true },
    });
    expect(deliveries).toHaveLength(1);
    const repeatedDirect = await sender.sendDm(
      sender.peerId,
      receiver.peerId,
      "persisted DM",
      options,
    );
    expect(repeatedDirect.delivery).toEqual({
      status: "delivered",
      persisted: true,
    });
    expect(directDeliveries).toHaveLength(1);
    expect(await sender.readRoomMessages(room.id)).toHaveLength(1);
  } finally {
    await receiver.shutdown();
    await sender.shutdown();
  }
});
