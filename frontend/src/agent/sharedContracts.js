import { normalizeAgentEvent, normalizeWebSocketMessage } from "@anomalo/contracts";

export function parseAgentEvent(value) {
  return normalizeAgentEvent(value);
}

export function parseWebSocketMessage(value) {
  return normalizeWebSocketMessage(value);
}
