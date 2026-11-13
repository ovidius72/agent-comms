import { bytesFromHex } from "wire-mesh-core/domain/device-id";
import { randomId } from "./random-id.js";
import { CommsError } from "./store.js";

export function sendMessageId(id?: string): Uint8Array<ArrayBuffer> {
  if (id === undefined) return randomId();
  if (!/^(?:[0-9a-f]{2})+$/i.test(id)) {
    throw new CommsError(
      "messageId must be non-empty even-length hexadecimal",
      "INVALID_MESSAGE_ID",
    );
  }
  return Uint8Array.from(bytesFromHex(id.toLowerCase()));
}
