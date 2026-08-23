import { describe, expect, it } from "vitest";

import { HookRelay } from "./hook-relay.js";

class FakeGateway {
  states: Array<[string, string | undefined]> = [];
  approvals: Array<[string, string]> = [];
  choice = "approve";
  fail = false;

  setState(state: string, text?: string): void {
    if (this.fail) throw new Error("device offline");
    this.states.push([state, text]);
  }

  setText(): void {}

  showApproval(requestId: string, text: string): void {
    this.approvals.push([requestId, text]);
  }

  async requestApproval(requestId: string, text: string): Promise<{ payload: Record<string, unknown> }> {
    this.approvals.push([requestId, text]);
    return { payload: { id: requestId, choice: this.choice } };
  }
}

describe("HookRelay", () => {
  it("resets a session to idle on SessionStart", async () => {
    const gateway = new FakeGateway();
    const result = await new HookRelay(gateway).handleBody("SessionStart", { session_id: "session-1", sequence: 1 });
    expect(result).toMatchObject({ applied: true, state: "IDLE", buddy_state: "idle" });
    expect(gateway.states).toEqual([["idle", undefined]]);
  });

  it("projects state and ignores duplicate sequence numbers", async () => {
    const gateway = new FakeGateway();
    const relay = new HookRelay(gateway);
    const first = await relay.handleBody("UserPromptSubmit", { session_id: "session-1", sequence: 1, text: "start" });
    const duplicate = await relay.handleBody("preToolUse", { session_id: "session-1", sequence: 1, tool_name: "shell" });
    expect(first).toMatchObject({ applied: true, state: "RUNNING", buddy_state: "coding" });
    expect(duplicate).toMatchObject({ applied: false, duplicate: true });
    expect(gateway.states).toEqual([["coding", "start"]]);
  });

  it("isolates sessions and does not rewind on stale events", async () => {
    const relay = new HookRelay(new FakeGateway());
    await relay.handleBody("UserPromptSubmit", { session_id: "a", sequence: 2 });
    const stale = await relay.handleBody("SessionEnd", { session_id: "a", sequence: 1, reason: "error" });
    const other = await relay.handleBody("SessionEnd", { session_id: "b", sequence: 1, reason: "complete" });
    expect(stale.duplicate).toBe(true);
    expect(relay.snapshot("a")?.state).toBe("RUNNING");
    expect(other.state).toBe("IDLE");
  });

  it("keeps top-level terminal reasons in the transition payload", async () => {
    const relay = new HookRelay(new FakeGateway());
    const cancelled = await relay.handleBody("Stop", { session_id: "cancelled", reason: "cancelled" });
    const failed = await relay.handleBody("SessionEnd", { session_id: "failed", status: "error" });

    expect(cancelled).toMatchObject({ state: "CANCELLED", buddy_state: "idle" });
    expect(failed).toMatchObject({ state: "FAILED", buddy_state: "error" });
  });

  it("returns allow and deny effects when approval is enabled", async () => {
    const allowedGateway = new FakeGateway();
    const allowed = await new HookRelay(allowedGateway, { approvalEnabled: true }).handleBody("PermissionRequest", {
      session_id: "allow", sequence: 1, request_id: "req-1", text: "Run command",
    });
    const deniedGateway = new FakeGateway();
    deniedGateway.choice = "deny";
    const denied = await new HookRelay(deniedGateway, { approvalEnabled: true }).handleBody("PermissionRequest", {
      session_id: "deny", sequence: 1, request_id: "req-2", text: "Delete file",
    });
    expect(allowed.effect).toEqual({ behavior: "allow" });
    expect(allowed.state).toBe("RUNNING");
    expect(allowed.buddy_state).toBe("coding");
    expect(allowedGateway.approvals).toEqual([["req-1", "Run command"]]);
    expect(allowedGateway.states).toEqual([["coding", undefined]]);
    expect(denied.effect).toEqual({ behavior: "deny", message: "Buddy denied the request." });
    expect(denied.state).toBe("CANCELLED");
    expect(denied.buddy_state).toBe("idle");
    expect(deniedGateway.approvals).toEqual([["req-2", "Delete file"]]);
    expect(deniedGateway.states).toEqual([["idle", undefined]]);
  });

  it("sends one approval command when the approval bridge is disabled", async () => {
    const gateway = new FakeGateway();
    const result = await new HookRelay(gateway).handleBody("PermissionRequest", {
      session_id: "session-1", sequence: 1, request_id: "req-1", text: "Run command",
    });

    expect(result.effect).toEqual({});
    expect(gateway.approvals).toEqual([["req-1", "Run command"]]);
    expect(gateway.states).toEqual([]);
  });

  it("does not require approval for a permission event explicitly marked informational", async () => {
    const gateway = new FakeGateway();
    const result = await new HookRelay(gateway, { approvalEnabled: true }).handleBody("PermissionRequest", {
      session_id: "session-1", sequence: 1, requires_user_action: false, text: "Informational permission update",
    });

    expect(result).toMatchObject({ state: "RUNNING", buddy_state: "coding", effect: {} });
    expect(gateway.approvals).toEqual([]);
    expect(gateway.states).toEqual([["coding", "Informational permission update"]]);
  });

  it("fails open when Buddy projection is unavailable", async () => {
    const gateway = new FakeGateway();
    gateway.fail = true;
    const result = await new HookRelay(gateway).handleBody("ErrorOccurred", {
      session_id: "session-1", sequence: 1, message: "provider failed",
    });
    expect(result).toMatchObject({ applied: true, state: "FAILED", buddy_error: "device offline" });
    expect(result.effect).toEqual({});
  });
});
