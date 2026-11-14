import type {
  AcceptedMeshSession,
  ManageOutcome,
} from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import { ROOM_REQUEST_TIMEOUT_MS } from "./request-timeouts.js";

interface RequestOptions {
  token?: CapabilityToken | undefined;
  timeoutMs?: number | undefined;
}

/** Prevents late continuations from opening requests during transport shutdown. */
export class TransportRequests {
  constructor(
    private readonly isShuttingDown: () => boolean,
    private readonly frameScope: Readonly<CapabilityScope>,
  ) {}

  async send(
    session: AcceptedMeshSession,
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    options: Readonly<RequestOptions> = {},
  ): Promise<ManageOutcome> {
    if (this.isShuttingDown())
      return { result: "error", code: "shutting_down" };
    return session.sendManageRequest(
      command,
      scope,
      undefined,
      options.token,
      options.timeoutMs,
    );
  }

  async frame(
    session: AcceptedMeshSession,
    command: ManageCommand,
  ): Promise<ManageOutcome> {
    return this.send(session, command, this.frameScope, {
      timeoutMs: ROOM_REQUEST_TIMEOUT_MS,
    });
  }
}
