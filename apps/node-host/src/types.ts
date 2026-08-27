import type {
  AgentEvent,
  EntryId,
  PresetModelRef,
  ResponseFormat,
  RunId,
  SessionId,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@anomaloharis/contracts";
import type { PluginLock } from "./plugin-catalog.js";
import type { CompiledSkillSnapshot } from "./skills.js";

export type { AgentEvent, EntryId, PresetModelRef, ResponseFormat, RunId, SessionId, ToolCall, ToolDefinition, ToolResult };

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  [key: string]: unknown;
};

export type SearchMode = string;

export type BootstrapToolRequest = {
  name: string;
  resultKey?: string;
  arguments?: Record<string, unknown>;
  required?: boolean;
};

export type AgentRunInput = {
  sessionId: SessionId;
  runId: RunId;
  message: string | null;
  resume: boolean;
  promptProfile: string;
  systemPrompt?: string | undefined;
  model: string;
  presetModelRef?: PresetModelRef | undefined;
  compiledHash?: string | undefined;
  skillSnapshot?: CompiledSkillSnapshot | undefined;
  toolProtocol?: "openai" | "dsml" | "auto" | "none" | undefined;
  policy?: AgentPolicy | undefined;
  allowedPluginIds?: ReadonlySet<string> | undefined;
  allowedPluginLocks?: readonly PluginLock[] | undefined;
  historyMessages?: ModelMessage[] | undefined;
  temperature?: number | undefined;
  searchMode: SearchMode;
  allowedToolNames?: ReadonlySet<string> | undefined;
  responseFormat?: ResponseFormat | undefined;
  bootstrapTools?: BootstrapToolRequest[] | undefined;
};

export type AgentPolicy = {
  maxToolIterations: number;
  runTimeoutMs: number;
  bootstrapToolTimeoutMs: number;
  toolTimeoutMs: number;
  structuredOutputRetryCount: 1;
  toolExecution: "sequential";
  temperature?: number | undefined;
  responseFormat?: ResponseFormat | undefined;
  searchMode?: SearchMode | undefined;
};

export type ContextDiagnostics = {
  profile: string;
  model: string;
  searchMode: SearchMode;
  segmentCounts: Record<string, number>;
  totalMessageCount: number;
  toolCount: number;
  compiledHash?: string | undefined;
};

export type BuiltContext = {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  diagnostics: ContextDiagnostics;
};

export type ToolContext = {
  sessionId: SessionId;
  runId: RunId;
  toolCallId?: string | undefined;
  searchMode: SearchMode;
  model: string;
  presetModelRef?: PresetModelRef | undefined;
  activeSkills: ReadonlySet<string>;
  activeMcpServers: ReadonlySet<string>;
  skillSnapshot?: CompiledSkillSnapshot | undefined;
  allowedPluginIds?: ReadonlySet<string> | undefined;
  allowedPluginLocks?: readonly PluginLock[] | undefined;
};

export type NewSessionEntry = {
  entryId: EntryId;
  sessionId: SessionId;
  parentEntryId?: EntryId | undefined;
  runId?: RunId | undefined;
  kind: "message" | "compaction" | "system" | "event";
  role?: ModelMessage["role"] | undefined;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type SessionCheckpoint = {
  runId: RunId;
  sessionId: SessionId;
  reason: string;
  iteration: number;
  state: {
    promptProfile: string;
    systemPrompt?: string | undefined;
    originalUserContent: string;
    currentUserMessage: ModelMessage;
    assistantText: string;
    pendingToolCalls: ToolCall[];
    completedToolCallIds: string[];
    loopMessages: ModelMessage[];
    bootstrapContext: Record<string, unknown>[];
    responseFormat?: ResponseFormat | undefined;
    allowedToolNames?: string[] | undefined;
    model?: string;
    presetModelRef?: PresetModelRef | undefined;
    compiledHash?: string | undefined;
    skillSnapshot?: CompiledSkillSnapshot | undefined;
    toolProtocol?: "openai" | "dsml" | "auto" | "none" | undefined;
    policy?: AgentPolicy | undefined;
    allowedPluginIds?: string[] | undefined;
    allowedPluginLocks?: readonly PluginLock[] | undefined;
    temperature?: number | undefined;
    searchMode: SearchMode;
  };
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  sessionId: SessionId;
  schemaVersion: 2;
  title: string;
  activeLeafEntryId?: EntryId | undefined;
  searchMode: SearchMode;
  metadata: Record<string, unknown>;
  messages: ModelMessage[];
  activeSkills: string[];
  activeMcpServers: string[];
  webTraces: Record<string, unknown>[];
  checkpoint?: SessionCheckpoint | undefined;
};

export type NewRunRecord = {
  runId: RunId;
  sessionId: SessionId;
  status: "active" | "paused" | "finished" | "error" | "stopped";
  startEntryId?: EntryId | undefined;
  lastEntryId?: EntryId | undefined;
  config: Record<string, unknown>;
  startedAt: string;
};

export type FinishedRunRecord = {
  runId: RunId;
  sessionId: SessionId;
  lastEntryId?: EntryId | undefined;
  endedAt: string;
};

export type FailedRunRecord = FinishedRunRecord & {
  errorCode: string;
};

export type SessionSummary = {
  sessionId: SessionId;
  title: string;
  messageCount: number;
  updatedAt: string;
  canResume: boolean;
  presetModelRef?: string | undefined;
};

export type SessionListQuery = {
  limit?: number;
};

export type ResumableRun = {
  runId: RunId;
  sessionId: SessionId;
  checkpoint: SessionCheckpoint;
};
