import { describe, expect, it } from "vitest";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import { sendMessageId } from "../core/send-message-id.js";
import { rememberMessage } from "../core/message-history.js";
import { DeliveryReceipts } from "../core/delivery-persistence.js";
import { RoomMessaging } from "../core/room-messaging.js";
import type { DmMessage, RoomMessage } from "../core/types.js";

const message: DmMessage = {
  id: "abcd",
  from: "sender",
  to: "recipient",
  content: "hello",
  timestamp: new Date().toISOString(),
  readBy: ["sender"],
};

describe("stable send identity", () => {
  it("uses the supplied ID, normalized as hex, or generates a fresh ID", () => {
    expect(bytesToHex(sendMessageId("ABCD"))).toBe("abcd");
    expect(sendMessageId()).not.toEqual(sendMessageId());
  });

  it.each(["", "abc", "gh", "  ab"])("rejects an invalid ID: %j", (id) => {
    expect(() => sendMessageId(id)).toThrow(
      expect.objectContaining({ code: "INVALID_MESSAGE_ID" }),
    );
  });

  it("keeps one local record for retries, ignoring receipt metadata", () => {
    const { history } = rememberMessage([], message);
    expect(
      rememberMessage(history, { ...message, timestamp: "later", readBy: [] })
        .message,
    ).toBe(message);
    expect(history).toHaveLength(1);
  });

  it.each([
    { content: "changed" },
    { to: "other" },
    { streamingBehavior: "steer" as const },
  ])("rejects changing a DM under the same ID: %j", (change) => {
    expect(() => rememberMessage([message], { ...message, ...change })).toThrow(
      expect.objectContaining({ code: "MESSAGE_ID_CONFLICT" }),
    );
  });

  it("checks a room message's reply target too", () => {
    const roomMessage: RoomMessage = {
      id: "ab",
      from: "sender",
      room: "room",
      content: "hi",
      timestamp: "now",
      readBy: [],
    };
    expect(() =>
      rememberMessage([roomMessage], { ...roomMessage, replyTo: "cd" }),
    ).toThrow();
  });

  it("does not expose a failed self-DM in local history", async () => {
    const dms = new Map<string, DmMessage[]>();
    const messaging = new RoomMessaging({
      dms,
      messages: new Map(),
      rooms: new Map(),
      deliveryReceipts: new DeliveryReceipts(),
      requireIdentity: () => {
        throw new Error("self-DM needs no transport identity");
      },
      resolveAgent: async () => undefined,
      resolveRoomId: (name) => name,
      requestDmAccess: async () => undefined,
      roomProtocol: {
        sendRoomRequestToMember: async () => {
          throw new Error("no wire for self-DM");
        },
      },
    });
    await expect(
      messaging.sendDm("self", "self", "note", {
        messageId: "abcd",
        requirePersistence: true,
      }),
    ).rejects.toMatchObject({ code: "SEND_REFUSED" });
    expect(dms.size).toBe(0);
  });
});
