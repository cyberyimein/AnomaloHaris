export const SEARCH_MODES = ["native", "subagent", "diy"] as const;

export type RetrievalSearchMode = (typeof SEARCH_MODES)[number];

export const DEFAULT_SEARCH_MODE: RetrievalSearchMode = "diy";
export const DEFAULT_SUBAGENT_MODEL = "deepseek/deepseek-v4-flash-0731";

export function isSearchMode(value: unknown): value is RetrievalSearchMode {
  return typeof value === "string" && (SEARCH_MODES as readonly string[]).includes(value);
}
