import { normalizeAgentEvent, normalizeWebSocketMessage } from "@anomaloharis/contracts";

export function parseAgentEvent(value) {
  return normalizeAgentEvent(value);
}

export function parseWebSocketMessage(value) {
  return normalizeWebSocketMessage(value);
}
