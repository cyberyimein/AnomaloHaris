import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import type { PluginExecutionScope, PluginHost } from "./plugins.js";
import type { ToolContext } from "./types.js";

export interface ToolRuntime {
  list(context: ToolContext): Promise<ToolDefinition[]>;
  call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  status(context: ToolContext): Promise<Record<string, unknown>[]>;
}

export type ToolHandler = (
  arguments_: Record<string, unknown>,
  context: ToolContext,
  signal: AbortSignal,
) => ToolResult | Promise<ToolResult>;

export type ToolAdapter = {
  id: string;
  priority: number;
  list(context: ToolContext): Promise<ToolDefinition[]>;
  call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  status(context: ToolContext): Promise<Record<string, unknown>>;
};

export function asToolAdapter(id: string, priority: number, runtime: ToolRuntime): ToolAdapter {
  return {
    id,
    priority,
    list: (context) => runtime.list(context),
    call: (call, context, signal) => runtime.call(call, context, signal),
    status: async (context) => ({ provider: id, ...(await runtime.status(context)).reduce((value, item) => ({ ...value, ...item }), {}) }),
  };
}

export class DeterministicToolRuntime implements ToolRuntime {
  private readonly definitions: Map<string, ToolDefinition>;
  private readonly handlers: Map<string, ToolHandler>;
  readonly calls: Array<{ call: ToolCall; context: ToolContext }> = [];

  constructor(definitions: ToolDefinition[], handlers: Record<string, ToolHandler> = {}) {
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]));
    this.handlers = new Map(Object.entries(handlers));
    const duplicateCount = definitions.length - this.definitions.size;
    if (duplicateCount > 0) throw new Error("Duplicate tool names are not allowed.");
  }

  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    return [...this.definitions.values()].map((definition) => structuredClone(definition));
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return abortedResult(call.name);
    const definition = this.definitions.get(call.name);
    if (!definition) return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: {} };
    this.calls.push({ call: structuredClone(call), context });
    const handler = this.handlers.get(call.name);
    if (!handler) return { name: call.name, ok: false, content: `No handler for ${call.name}.`, data: {} };
    try {
      const result = await handler(call.arguments, context, signal);
      return {
        name: result.name || call.name,
        ok: result.ok,
        content: result.content,
        data: result.data ?? {},
      };
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
        data: { error_type: error instanceof Error ? error.name : "Error" },
      };
    }
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "DeterministicToolRuntime", tools: await this.list(context) }];
  }
}

/**
 * Merges the migrated adapters behind the ToolRuntime seam. Equal-priority
 * collisions are errors; a provider can only override another provider when
 * the configured priority says so explicitly.
 */
export class CompositeToolRuntime implements ToolRuntime {
  constructor(private readonly adapters: readonly ToolAdapter[]) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    const selected = await this.resolve(context);
    return [...selected.values()].map(({ definition }) => structuredClone(definition));
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    const selected = await this.resolve(context);
    const owner = selected.get(call.name);
    if (!owner) return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
    try {
      return await owner.adapter.call(call, context, signal);
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        data: { error_code: "tool_failed", adapter: owner.adapter.id },
      };
    }
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return Promise.all(this.adapters
      .filter((adapter) => !context.allowedPluginIds || context.allowedPluginIds.has(adapter.id))
      .map((adapter) => adapter.status(context)));
  }

  private async resolve(context: ToolContext): Promise<Map<string, { definition: ToolDefinition; adapter: ToolAdapter }>> {
    const selected = new Map<string, { definition: ToolDefinition; adapter: ToolAdapter }>();
    for (const adapter of this.adapters) {
      if (context.allowedPluginIds && !context.allowedPluginIds.has(adapter.id)) continue;
      for (const definition of await adapter.list(context)) {
        const existing = selected.get(definition.name);
        if (existing && existing.adapter.priority === adapter.priority) {
          throw new Error(`Tool ${definition.name} is registered by ${existing.adapter.id} and ${adapter.id} at the same priority.`);
        }
        if (!existing || adapter.priority > existing.adapter.priority) {
          selected.set(definition.name, { definition, adapter });
        }
      }
    }
    return selected;
  }
}

export class CoreToolRuntime implements ToolRuntime {
  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    return [{
      name: "time_now",
      description: "Return the current time from the Node Host.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone name, such as UTC or Asia/Tokyo.",
            default: "UTC",
          },
        },
        additionalProperties: false,
      },
      source: "host-core",
    }];
  }

  async call(call: ToolCall, _context: ToolContext, _signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== "time_now") return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
    const timezone = optionalTimezone(call.arguments.timezone, "UTC");
    try {
      const now = new Date();
      const timestamp = timezone === "UTC" ? now.toISOString() : formatZonedIso(now, timezone);
      return { name: call.name, ok: true, content: timestamp, data: { timestamp, timezone } };
    } catch (error) {
      return { name: call.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_code: "invalid_timezone", timezone } };
    }
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "host-core", available: true, tool_count: (await this.list(context)).length }];
  }
}

/**
 * Timezone-aware tools kept separate from host-core so existing Preset Model
 * plugin locks remain stable while retrieval-only models can opt into them.
 */
export class TimeZoneToolRuntime implements ToolRuntime {
  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    return [
      {
        name: "core_get_time",
        description: "Get the current time for a timezone.",
        parameters: {
          type: "object",
          properties: {
            timezone: {
              type: "string",
              description: "IANA timezone name, e.g. Asia/Tokyo or UTC.",
              default: "Asia/Tokyo",
            },
          },
          required: [],
          additionalProperties: false,
        },
        source: "time-tools",
      },
      {
        name: "core_convert_time",
        description: "Convert an ISO 8601 date-time between timezones deterministically.",
        parameters: {
          type: "object",
          properties: {
            datetime: {
              type: "string",
              description: "ISO 8601 date-time. Include an offset, or provide from_timezone for a local time.",
            },
            from_timezone: {
              type: "string",
              description: "IANA timezone for an input without an offset.",
            },
            to_timezone: {
              type: "string",
              description: "Target IANA timezone, such as UTC or Asia/Tokyo.",
              default: "UTC",
            },
            fold: {
              type: "integer",
              description: "For an ambiguous daylight-saving local time, use 0 for the first occurrence or 1 for the second.",
              minimum: 0,
              maximum: 1,
              default: 0,
            },
          },
          required: ["datetime"],
          additionalProperties: false,
        },
        source: "time-tools",
      },
    ];
  }

  async call(call: ToolCall, _context: ToolContext, _signal: AbortSignal): Promise<ToolResult> {
    if (call.name === "core_get_time") return this.getTime(call);
    if (call.name === "core_convert_time") return this.convertTime(call);
    return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "time-tools", available: true, tool_count: (await this.list(context)).length }];
  }

  private getTime(call: ToolCall): ToolResult {
    const timezone = optionalTimezone(call.arguments.timezone, "Asia/Tokyo");
    try {
      const iso = formatZonedIso(new Date(), timezone);
      return { name: call.name, ok: true, content: iso, data: { timezone, iso } };
    } catch (error) {
      return { name: call.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_code: "invalid_timezone", timezone } };
    }
  }

  private convertTime(call: ToolCall): ToolResult {
    const rawDatetime = String(call.arguments.datetime ?? "").trim();
    if (!rawDatetime) return { name: call.name, ok: false, content: "datetime is required", data: {} };

    const targetName = String(call.arguments.to_timezone ?? "UTC").trim() || "UTC";
    try {
      assertTimeZone(targetName);
    } catch (error) {
      return { name: call.name, ok: false, content: `Unknown target timezone: ${targetName}`, data: { error_code: "invalid_timezone" } };
    }

    const sourceName = String(call.arguments.from_timezone ?? "").trim();
    const fold = parseFold(call.arguments.fold);
    if (fold === undefined) return { name: call.name, ok: false, content: "fold must be 0 or 1", data: {} };

    let source: Date;
    let resolvedSourceName: string;
    let sourceIso: string;
    const offsetInput = hasIsoOffset(rawDatetime);
    if (offsetInput) {
      const parsed = new Date(rawDatetime.replace(/z$/i, "Z"));
      if (Number.isNaN(parsed.getTime())) {
        return { name: call.name, ok: false, content: "datetime must be a valid ISO 8601 date-time", data: {} };
      }
      source = parsed;
      resolvedSourceName = offsetLabel(rawDatetime);
      sourceIso = normalizeOffsetInput(rawDatetime);
    } else {
      if (!sourceName) {
        return { name: call.name, ok: false, content: "from_timezone is required when datetime has no UTC offset", data: {} };
      }
      try {
        assertTimeZone(sourceName);
        source = resolveLocalDateTime(rawDatetime, sourceName, fold);
      } catch (error) {
        return { name: call.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_code: "invalid_datetime" } };
      }
      resolvedSourceName = sourceName;
      sourceIso = formatZonedIso(source, sourceName);
    }

    const convertedIso = formatZonedIso(source, targetName);
    const utcIso = source.toISOString();
    const data = {
      input: rawDatetime,
      source_timezone: resolvedSourceName,
      target_timezone: targetName,
      source_iso: sourceIso,
      converted_iso: convertedIso,
      utc_iso: utcIso,
      unix_timestamp: source.getTime() / 1_000,
      fold,
    };
    return { name: call.name, ok: true, content: JSON.stringify(data), data };
  }
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type WallTime = ZonedParts & { millisecond: number };

function optionalTimezone(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function assertTimeZone(timezone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
}

function zonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const result = {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
  if (Object.values(result).some((value) => !Number.isInteger(value))) throw new Error(`Unable to format time in ${timezone}`);
  return {
    year: result.year!,
    month: result.month!,
    day: result.day!,
    hour: result.hour!,
    minute: result.minute!,
    second: result.second!,
  };
}

function timezoneOffsetMs(date: Date, timezone: string, parts = zonedParts(date, timezone)): number {
  const instantWithoutMilliseconds = date.getTime() - date.getUTCMilliseconds();
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instantWithoutMilliseconds;
}

function formatZonedIso(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  const offsetMinutes = Math.round(timezoneOffsetMs(date, timezone, parts) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  return `${parts.year.toString().padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}.${milliseconds}${sign}${hours}:${minutes}`;
}

function parseFold(value: unknown): 0 | 1 | undefined {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && (parsed === 0 || parsed === 1) ? parsed : undefined;
}

function hasIsoOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function offsetLabel(value: string): string {
  if (/z$/i.test(value)) return "UTC";
  const match = value.match(/([+-]\d{2}:?\d{2})$/);
  return match ? `UTC${match[1]!.replace(/(\d{2})(\d{2})$/, "$1:$2")}` : "UTC";
}

function normalizeOffsetInput(value: string): string {
  return /z$/i.test(value) ? `${value.slice(0, -1)}+00:00` : value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

function parseWallTime(value: string): WallTime {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(value);
  if (!match) throw new Error("datetime must be a valid ISO 8601 date-time");
  const wall: WallTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
    millisecond: Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || "0"),
  };
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond));
  if (Number.isNaN(check.getTime()) || check.getUTCFullYear() !== wall.year || check.getUTCMonth() !== wall.month - 1 || check.getUTCDate() !== wall.day || check.getUTCHours() !== wall.hour || check.getUTCMinutes() !== wall.minute || check.getUTCSeconds() !== wall.second || check.getUTCMilliseconds() !== wall.millisecond) {
    throw new Error("datetime must be a valid ISO 8601 date-time");
  }
  return wall;
}

function resolveLocalDateTime(value: string, timezone: string, fold: 0 | 1): Date {
  const wall = parseWallTime(value);
  const wallMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  const offsets = new Set<number>();
  for (const delta of [-86_400_000, -7_200_000, -3_600_000, 0, 3_600_000, 7_200_000, 86_400_000]) {
    const candidate = new Date(wallMs + delta);
    offsets.add(timezoneOffsetMs(candidate, timezone));
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wallMs - offset))
    .filter((candidate) => {
      const parts = zonedParts(candidate, timezone);
      return parts.year === wall.year && parts.month === wall.month && parts.day === wall.day && parts.hour === wall.hour && parts.minute === wall.minute && parts.second === wall.second && candidate.getUTCMilliseconds() === wall.millisecond;
    })
    .sort((left, right) => left.getTime() - right.getTime());
  if (candidates.length === 0) throw new Error(`Local time ${value} does not exist in ${timezone} because of a timezone offset transition`);
  return candidates[Math.min(fold, candidates.length - 1)]!;
}

export class PluginToolAdapter implements ToolAdapter {
  readonly id = "pi-plugin-host";
  readonly priority = 20;

  constructor(private readonly plugins: PluginHost) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    return this.plugins.tools({
      pluginId: "host",
      sessionId: context.sessionId,
      runId: context.runId,
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    }, context.allowedPluginIds
      ? { pluginIds: context.allowedPluginIds, ...(context.allowedPluginLocks ? { locks: context.allowedPluginLocks } : {}) }
      : undefined);
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    return this.plugins.callTool(
      call,
      context,
      signal,
      context.allowedPluginIds
        ? { pluginIds: context.allowedPluginIds, ...(context.allowedPluginLocks ? { locks: context.allowedPluginLocks } : {}) }
        : undefined,
    );
  }

  async status(_context: ToolContext): Promise<Record<string, unknown>> {
    const scope: PluginExecutionScope | undefined = _context.allowedPluginIds
      ? { pluginIds: _context.allowedPluginIds, ...(_context.allowedPluginLocks ? { locks: _context.allowedPluginLocks } : {}) }
      : undefined;
    return { provider: this.id, plugins: this.plugins.status(scope) };
  }
}

function abortedResult(name: string): ToolResult {
  return {
    name,
    ok: false,
    content: "Tool execution cancelled.",
    data: { error_code: "cancelled" },
  };
}
