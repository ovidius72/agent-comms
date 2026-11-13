import {
  DeliveryReceipts,
  type MessageEvent,
} from "../core/delivery-persistence.js";
import { FileReceipts } from "./persisted-delivery.helper.js";

const [directory, mode] = process.argv.slice(2);
const KEEPALIVE_MS = 1_000;
if (directory === undefined) throw new Error("Missing fixture directory");
const disk = new FileReceipts(directory);
const event: MessageEvent = {
  type: "dm",
  message: {
    id: "ab",
    from: "sender",
    to: "receiver",
    content: "survive the crash",
    timestamp: "2026-11-13T00:00:00.000Z",
    readBy: ["sender"],
  },
};
const receipts = new DeliveryReceipts({
  accept: async (delivery) => {
    const stored = await disk.accept(delivery);
    if (mode === "crash") {
      process.stdout.write("committed-before-receipt\n");
      setInterval(() => undefined, KEEPALIVE_MS);
      await new Promise<never>(() => undefined);
    }
    return stored;
  },
});
const result = await receipts.accept("dm", "receiver", event, true);
process.stdout.write(JSON.stringify(result) + "\n");
