import { describe, expect, it, vi } from "vitest";
import {
  DeliveryReceipts,
  PERSISTED_SEND_VERB,
  type DeliveryPersistence,
  type StoredDelivery,
} from "../core/delivery-persistence.js";
import { RoomProtocol } from "../core/room-protocol.js";
import { dmRoomPath, ownerNamedRoomPath } from "../core/room-path.js";
import { saveRoomToken } from "../core/identity-store.js";
import { createRoomRouter } from "../core/room-router.js";
import { noopTransportEvents } from "./test-transport.js";
import {
  handle,
  makeHarness,
  manageRequest,
  mintRoomToken,
  room,
  SAMPLE_MESSAGE_ID,
} from "./room-protocol.helper.js";

function memoryReceipts(): DeliveryPersistence {
  const records = new Map<string, StoredDelivery>();
  return {
    accept: async (delivery) => {
      const prior = records.get(delivery.key);
      if (prior !== undefined) return { delivery: prior, inserted: false };
      records.set(delivery.key, structuredClone(delivery));
      return { delivery, inserted: true };
    },
  };
}

async function receiver({
  persistence,
  dm = false,
}: { persistence?: DeliveryPersistence; dm?: boolean } = {}) {
  const h = await makeHarness();
  const path = dm
    ? dmRoomPath(h.ids.ownerId, h.ids.memberId)
    : ownerNamedRoomPath(h.ids.ownerId, "general");
  h.deps.rooms.set(
    path,
    room({
      id: path,
      owner: h.ids.ownerId,
      members: [h.ids.ownerId, h.ids.memberId],
    }),
  );
  const token = await mintRoomToken(h.ids.ownerPort, h.ids.memberId, path);
  const protocol = new RoomProtocol({
    ...h.deps,
    deliveryReceipts: new DeliveryReceipts(persistence),
  });
  const send = async ({
    text = "hello",
    verb = PERSISTED_SEND_VERB,
    presentedToken = token,
  } = {}) => {
    const handler = protocol.roomVerbHandlers[verb];
    if (handler === undefined) throw new Error("Missing handler");
    return handler(
      manageRequest({
        scope: { kind: "room", path },
        token: presentedToken,
        params: {
          verb,
          "message-id": SAMPLE_MESSAGE_ID,
          "sent-at": Date.now(),
          text,
        },
      }),
      handle(h.ids.memberId),
    );
  };
  return { h, path, protocol, send, token };
}

describe("persisted delivery receipts", () => {
  it.each([false, true])(
    "waits for durable acceptance before observers and receipt (DM=%s)",
    async (dm) => {
      let commit!: () => void;
      const gate = new Promise<void>((resolve) => {
        commit = resolve;
      });
      const accept = vi.fn<DeliveryPersistence["accept"]>(async (delivery) => {
        await gate;
        return { delivery, inserted: true };
      });
      const { h, send } = await receiver({ persistence: { accept }, dm });
      let answered = false;
      const pending = send().then((value) => {
        answered = true;
        return value;
      });
      await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
      expect(answered).toBe(false);
      expect(h.queueDelivery).not.toHaveBeenCalled();
      expect(h.fireLocalDelivery).not.toHaveBeenCalled();
      expect(h.deps.messages.size + h.deps.dms.size).toBe(0);
      commit();
      expect(await pending).toEqual({
        result: "ok",
        "delivery-receipt": "persisted",
      });
      expect(h.fireLocalDelivery).toHaveBeenCalledOnce();
    },
  );

  it("does not invoke persistence for unauthenticated or malformed requests", async () => {
    const accept = vi.fn<DeliveryPersistence["accept"]>();
    const { h, protocol, path, send } = await receiver({
      persistence: { accept },
    });
    const wrong = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, path);
    expect(await send({ presentedToken: wrong })).toMatchObject({
      code: "unauthorized",
    });
    const handler = protocol.roomVerbHandlers[PERSISTED_SEND_VERB]!;
    expect(
      await handler(
        manageRequest({ scope: { kind: "room", path } }),
        handle(h.ids.memberId),
      ),
    ).toMatchObject({ code: "unauthorized" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses a required receipt when no persistence provider is installed", async () => {
    const { h, send } = await receiver();
    expect(await send()).toEqual({
      result: "error",
      code: "delivery_persistence_unsupported",
    });
    expect(h.fireLocalDelivery).not.toHaveBeenCalled();
    expect(await send({ text: "legacy", verb: "room.send" })).toEqual({
      result: "ok",
    });
  });

  it("fails closed on a storage error, then accepts an explicit retry", async () => {
    const records = memoryReceipts();
    const accept = vi
      .fn(records.accept)
      .mockRejectedValueOnce(new Error("disk full"));
    const { h, send } = await receiver({ persistence: { accept } });
    expect(await send()).toEqual({
      result: "error",
      code: "delivery_storage_failed",
    });
    expect(h.fireLocalDelivery).not.toHaveBeenCalled();
    expect(await send()).toMatchObject({
      result: "ok",
      "delivery-receipt": "persisted",
    });
    expect(h.fireLocalDelivery).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent and repeated sends but rejects changed content", async () => {
    const { h, send, path } = await receiver({ persistence: memoryReceipts() });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.every((result) => result.result === "ok")).toBe(true);
    expect(h.fireLocalDelivery).toHaveBeenCalledOnce();
    expect(h.deps.messages.get(path)).toHaveLength(1);
    expect(await send({ text: "different" })).toEqual({
      result: "error",
      code: "message_id_conflict",
    });
    expect(h.fireLocalDelivery).toHaveBeenCalledOnce();
  });

  it("also persists ordinary sends when the receiver opts in", async () => {
    const { send } = await receiver({ persistence: memoryReceipts() });
    expect(await send({ verb: "room.send" })).toEqual({
      result: "ok",
      "delivery-receipt": "persisted",
    });
  });

  it("old-peer routing rejects the new verb without running the legacy handler", async () => {
    const legacy = vi.fn().mockResolvedValue({ result: "ok" });
    const router = createRoomRouter({
      events: noopTransportEvents(),
      handlers: { "room.send": legacy },
    });
    const request = manageRequest({ params: { verb: PERSISTED_SEND_VERB } });
    await router.handleLocalRequest(request, { id: "peer" });
    expect(request.respond).toHaveBeenCalledWith({
      result: "error",
      code: "unsupported_verb",
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("never treats a plain ok response as a persisted receipt", async () => {
    const { h, path, token, protocol } = await receiver();
    const result = await protocol.sendRoomRequestToMember(
      h.ids.memberId,
      path,
      token,
      { verb: PERSISTED_SEND_VERB },
    );
    expect(result).toEqual({
      kind: "refused",
      code: "delivery_persistence_unsupported",
    });
  });

  it("preserves the persisted flag and message ID after a retry", async () => {
    const { h, path, token, protocol } = await receiver();
    saveRoomToken(
      { harness: "test", cwd: "room-protocol", dir: h.slotDir },
      path,
      token,
    );
    h.sendRoomRequest
      .mockResolvedValueOnce({
        result: "error",
        code: "delivery_storage_failed",
      })
      .mockResolvedValueOnce({ result: "ok", "delivery-receipt": "persisted" });
    expect(
      await protocol.sendRoomRequestToMember(h.ids.ownerId, path, token, {
        verb: PERSISTED_SEND_VERB,
        "message-id": SAMPLE_MESSAGE_ID,
      }),
    ).toEqual({ kind: "undelivered", reason: "storage_unavailable" });
    await protocol.flushPendingRoomRequests(h.ids.ownerId);
    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({
        type: "delivery_status",
        messageId: Buffer.from(SAMPLE_MESSAGE_ID).toString("hex"),
        delivery: { status: "delivered", persisted: true },
      }),
    );
  });
});
