/** Optional durable acceptance of authenticated messages, before their wire receipt. */
import type { DeliveryEvent, StreamingBehavior } from "./types.js";

export const PERSISTED_SEND_VERB = "room.send.persisted";

export type MessageEvent = Extract<
  DeliveryEvent,
  { type: "dm" | "room_message" }
>;

/** A receiver-scoped identity and immutable message content, built by the library. */
export interface StoredDelivery {
  readonly key: string;
  readonly recipient: string;
  readonly room: string;
  readonly fingerprint: string;
  readonly event: MessageEvent;
}

/**
 * Implement atomically: insert and durably commit, or return the already committed record.
 * An error must reject. Do not overwrite an existing key or evict it while retries are supported.
 * This is acceptance, not human reading, model execution or a conversation archive.
 */
export interface DeliveryPersistence {
  accept: (delivery: Readonly<StoredDelivery>) => Promise<{
    readonly delivery: StoredDelivery;
    readonly inserted: boolean;
  }>;
}

/** Mesh-only send guarantees. Keep the same messageId and payload for an explicit retry. */
export interface MeshSendOptions {
  /** Non-empty, even-length hexadecimal wire message ID. Omitted: generate a fresh ID. */
  readonly messageId?: string | undefined;
  /** Require a persisted receipt. An old or unconfigured receiver refuses without delivery. */
  readonly requirePersistence?: boolean | undefined;
}

/** The legacy fourth-argument string remains valid; new callers use one options object. */
export type MeshDmSendOptions = MeshSendOptions & {
  readonly streamingBehavior?: StreamingBehavior | undefined;
};

export function messageFingerprint(event: MessageEvent): string {
  const message = event.message;
  return JSON.stringify([
    event.type,
    message.from,
    "to" in message ? message.to : message.room,
    message.content,
    "replyTo" in message ? (message.replyTo ?? null) : null,
    message.streamingBehavior ?? null,
  ]);
}

/** Persistence is authoritative across process restarts; observers remain non-blocking. */
export class DeliveryReceipts {
  constructor(private readonly persistence?: DeliveryPersistence) {}

  async accept(
    room: string,
    recipient: string,
    event: MessageEvent,
    required: boolean,
  ): Promise<
    | { ok: true; persisted: boolean; duplicate: boolean }
    | { ok: false; code: string }
  > {
    if (this.persistence === undefined) {
      return required
        ? { ok: false, code: "delivery_persistence_unsupported" }
        : { ok: true, persisted: false, duplicate: false };
    }
    const key = JSON.stringify([
      recipient,
      room,
      event.message.from,
      event.message.id,
    ]);
    const delivery: StoredDelivery = {
      key,
      room,
      recipient,
      fingerprint: messageFingerprint(event),
      event,
    };
    try {
      const accepted = await this.persistence.accept(structuredClone(delivery));
      if (
        accepted.delivery.key !== key ||
        accepted.delivery.room !== room ||
        accepted.delivery.recipient !== recipient ||
        accepted.delivery.fingerprint !== delivery.fingerprint ||
        messageFingerprint(accepted.delivery.event) !== delivery.fingerprint
      ) {
        return { ok: false, code: "message_id_conflict" };
      }
      return { ok: true, persisted: true, duplicate: !accepted.inserted };
    } catch {
      return { ok: false, code: "delivery_storage_failed" };
    }
  }
}
