import { once } from "node:events";
import { createConnection, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { BuddyConfigurationError, BuddyGateway } from "./gateway.js";

const gateways: BuddyGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.disconnect();
});

describe("BuddyGateway", () => {
  it("does not open a public listener without an explicit client allowlist", async () => {
    const gateway = new BuddyGateway({ transport: "tcp", tcpHost: "0.0.0.0", tcpPort: 0 });
    gateways.push(gateway);

    await expect(gateway.connect({ transport: "tcp", tcpHost: "0.0.0.0", tcpPort: 0 }))
      .rejects.toBeInstanceOf(BuddyConfigurationError);
  });

  it("accepts a TCP Buddy client, sends commands, and records JSON Lines events", async () => {
    const gateway = new BuddyGateway({
      transport: "tcp",
      tcpHost: "127.0.0.1",
      tcpPort: 0,
      eventBufferSize: 16,
    });
    gateways.push(gateway);
    const listening = await gateway.connect({ transport: "tcp", tcpHost: "127.0.0.1", tcpPort: 0 });
    if (listening.tcp_port === undefined) throw new Error("TCP listener did not expose an ephemeral port");

    const socket = createConnection({ host: "127.0.0.1", port: listening.tcp_port });
    await once(socket, "connect");
    await waitFor(() => gateway.isConnected());
    expect(await readOneLine(socket)).toContain("CB connect");

    const command = gateway.setState("coding", "working");
    expect(command.command).toBe("CODEX CODING working");
    const received = await readOneLine(socket);
    expect(received).toContain("CODEX CODING working");
    expect(() => gateway.setState("coding", "line one\nline two")).toThrow(BuddyConfigurationError);

    socket.write(`${JSON.stringify({ type: "approval.response", payload: { id: "request-1", choice: "approve" } })}\n`);
    await waitFor(() => gateway.getEvents().some((event) => event.type === "approval.response"));
    expect(gateway.getEvents().some((event) => event.type === "approval.response")).toBe(true);
    socket.destroy();
  });
});

async function readOneLine(socket: Socket): Promise<string> {
  let buffer = "";
  for (;;) {
    const [chunk] = await once(socket, "data") as [Buffer];
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return buffer.slice(0, newline);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error("Timed out waiting for Buddy gateway state");
}
