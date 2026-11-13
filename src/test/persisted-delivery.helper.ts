import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  DeliveryPersistence,
  StoredDelivery,
} from "../core/delivery-persistence.js";

const OWNER_ONLY_MODE = 0o600;

/** Single-writer fixture. Flush both the record and its directory before accepting. */
export class FileReceipts implements DeliveryPersistence {
  constructor(private readonly directory: string) {}

  async accept(delivery: Readonly<StoredDelivery>) {
    const filename = join(
      this.directory,
      createHash("sha256").update(delivery.key).digest("hex") + ".json",
    );
    if (existsSync(filename)) {
      return {
        delivery: JSON.parse(readFileSync(filename, "utf8")) as StoredDelivery,
        inserted: false,
      };
    }
    const fd = openSync(filename, "wx", OWNER_ONLY_MODE);
    try {
      writeFileSync(fd, JSON.stringify(delivery));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dir = openSync(this.directory, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return { delivery, inserted: true };
  }
}
