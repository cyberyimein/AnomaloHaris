import type { ToolDefinition } from "@anomaloharis/contracts";

/** Dashboard activation supplies these two tools outside the preset plugin graph. */
export function isDashboardBuddyTool(tool: ToolDefinition): boolean {
  return tool.source === "buddy-runtime"
    && (tool.name === "buddy_capabilities" || tool.name === "buddy_invoke");
}
