import { expect, test, vi } from "vitest";
import type { AcceptedMeshSession } from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { generateIdentity } from "../core/identity.js";
import { WireMeshTransport } from "../core/wire-mesh-transport.js";
import type { MeshMessage } from "../core/wire-protocol.js";
import { noopTransportEvents, waitFor } from "./test-transport.js";

// The existing shutdown tests use this same whitebox access to delay one real TLS
// session's close. A gate makes the race deterministic without changing deadlines.
function sessions(transport: WireMeshTransport): Set<AcceptedMeshSession> {
  return (transport as unknown as { allSessions: Set<AcceptedMeshSession> })
    .allSessions;
}

test.each(["send", "broadcast", "room"] as const)(
  "%s cannot create another request while shutdown is closing a session",
  async (method) => {
    const identityA = generateIdentity();
    const identityB = generateIdentity();
    const idA = deviceIdToHex(Uint8Array.from(identityA.deviceId));
    const idB = deviceIdToHex(Uint8Array.from(identityB.deviceId));
    const a = new WireMeshTransport(noopTransportEvents(), identityA);
    const b = new WireMeshTransport(noopTransportEvents(), identityB);
    const releaseClose = Promise.withResolvers<undefined>();
    const closeStarted = Promise.withResolvers<undefined>();
    let stopping: Promise<void> | undefined;
    try {
      await a.startDataServer();
      await b.connectToPeer(
        { id: idA, port: a.dataPort, startedAt: new Date().toISOString() },
        idB,
      );
      await waitFor(() => sessions(a).size > 0, "A tracks the real session");
      const [session] = sessions(a);
      if (session === undefined) throw new Error("missing session");
      const request = vi
        .spyOn(session, "sendManageRequest")
        .mockResolvedValue({ result: "ok" });
      const message: MeshMessage = { method: "peer_list", peers: [] };
      await a.send({ id: idB }, message);
      expect(request).toHaveBeenCalledOnce();
      request.mockClear();
      const close = session.close.bind(session);
      vi.spyOn(session, "close").mockImplementation(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
        await close();
      });
      stopping = a.shutdown();
      await closeStarted.promise;
      // Resume at the same point as handlePeerConnected's peer-list send after
      // its earlier state-sync await settles during shutdown.
      if (method === "send") await a.send({ id: idB }, message);
      else if (method === "broadcast") await a.broadcast(message);
      else {
        await expect(
          a.sendRoomRequest(
            idB,
            { verb: "version:get", params: { verb: "version.get" } },
            { kind: "node" },
          ),
        ).resolves.toEqual({ result: "error", code: "shutting_down" });
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      releaseClose.resolve();
      await stopping;
      await b.shutdown();
      await a.shutdown();
    }
  },
);

test("room requests after completed shutdown report shutdown, not a missing route", async () => {
  const transport = new WireMeshTransport(
    noopTransportEvents(),
    generateIdentity(),
  );
  await transport.shutdown();
  await expect(
    transport.sendRoomRequest(
      "unreachable",
      { verb: "version:get", params: { verb: "version.get" } },
      { kind: "node" },
    ),
  ).resolves.toEqual({ result: "error", code: "shutting_down" });
});
