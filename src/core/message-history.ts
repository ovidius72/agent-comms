import {
  messageFingerprint,
  type MessageEvent,
} from "./delivery-persistence.js";
import { CommsError } from "./store.js";
import type { DmMessage, RoomMessage } from "./types.js";

/** Retrying a wire ID must not duplicate local history or change its immutable content. */
export function rememberMessage<T extends DmMessage | RoomMessage>(
  history: readonly T[],
  message: T,
): { message: T; history: T[] } {
  const prior = history.find(
    (entry) => entry.id === message.id && entry.from === message.from,
  );
  if (prior !== undefined) {
    const fingerprint = (value: DmMessage | RoomMessage) =>
      messageFingerprint(
        "room" in value
          ? { type: "room_message", message: value }
          : { type: "dm", message: value },
      );
    if (fingerprint(prior) !== fingerprint(message)) {
      throw new CommsError(
        "messageId already names different content",
        "MESSAGE_ID_CONFLICT",
      );
    }
    return { message: prior, history: [...history] };
  }
  return { message, history: [...history, message] };
}

/** Incoming history remains a projection; durable acceptance happens before this call. */
export function recordReceivedMessage(
  event: MessageEvent,
  room: string,
  histories: {
    dms: Map<string, DmMessage[]>;
    messages: Map<string, RoomMessage[]>;
  },
): void {
  if (event.type === "dm") {
    const history = histories.dms.get(room) ?? [];
    history.push(event.message);
    histories.dms.set(room, history);
  } else {
    const history = histories.messages.get(room) ?? [];
    history.push(event.message);
    histories.messages.set(room, history);
  }
}
