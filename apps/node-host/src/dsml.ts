import type { ToolCall } from "@anomalo/contracts";

const DSML_TAG_PATTERN = "(?:｜|\\|)DSML(?:｜|\\|)";
const TOOL_CALLS_START = new RegExp(`<${DSML_TAG_PATTERN}tool_calls>`, "i");
const TOOL_CALLS_END = new RegExp(`</${DSML_TAG_PATTERN}tool_calls>`, "i");
const DSML_MARKER = new RegExp(`<${DSML_TAG_PATTERN}`, "i");
const BLOCK_START_PREFIXES = ["<｜DSML｜tool_calls>", "<|DSML|tool_calls>"];

export type DsmlParseResult = {
  text: string;
  calls: ToolCall[];
};

export class DsmlProtocolError extends Error {
  readonly errorCode = "provider_protocol_error";

  constructor(message: string) {
    super(message);
    this.name = "DsmlProtocolError";
  }
}

/**
 * Incrementally removes DeepSeek's encoded tool-call markup from provider text.
 * The parser deliberately holds a possible tag suffix until the next chunk so
 * a marker split at any byte/chunk boundary never leaks into assistant text.
 */
export class DsmlToolCallParser {
  private buffer = "";
  private nextCallNumber = 1;
  private sawMarkup = false;

  feed(chunk: string): DsmlParseResult {
    this.buffer += chunk;
    const result: DsmlParseResult = { text: "", calls: [] };

    while (this.buffer) {
      const start = this.buffer.search(TOOL_CALLS_START);
      if (start < 0) {
        const marker = this.buffer.search(DSML_MARKER);
        const holdFrom = marker >= 0 ? marker : possibleBlockPrefixStart(this.buffer);
        if (holdFrom === undefined) {
          result.text += this.buffer;
          this.buffer = "";
        } else {
          result.text += this.buffer.slice(0, holdFrom);
          this.buffer = this.buffer.slice(holdFrom);
        }
        break;
      }

      result.text += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start);
      const endMatch = TOOL_CALLS_END.exec(this.buffer);
      if (!endMatch || endMatch.index === undefined) break;

      const end = endMatch.index + endMatch[0].length;
      const block = this.buffer.slice(0, end);
      const calls = parseDsmlToolCallBlock(block, this.nextCallNumber);
      this.nextCallNumber += calls.length;
      result.calls.push(...calls);
      this.sawMarkup = true;
      this.buffer = this.buffer.slice(end);
    }

    return result;
  }

  finish(): DsmlParseResult {
    const result = this.feed("");
    if (this.buffer) {
      if (this.sawMarkup || DSML_MARKER.test(this.buffer) || possibleBlockPrefixStart(this.buffer) !== undefined) {
        throw new DsmlProtocolError("Incomplete DSML tool-call block from provider.");
      }
      result.text += this.buffer;
      this.buffer = "";
    }
    return result;
  }
}

export function parseDsmlContent(content: string): DsmlParseResult {
  const parser = new DsmlToolCallParser();
  const first = parser.feed(content);
  const last = parser.finish();
  return { text: first.text + last.text, calls: [...first.calls, ...last.calls] };
}

export function parseDsmlToolCallBlock(block: string, firstCallNumber = 1): ToolCall[] {
  if (!TOOL_CALLS_START.test(block) || !TOOL_CALLS_END.test(block)) {
    throw new DsmlProtocolError("DSML tool-call block is missing its wrapper.");
  }

  const invokeOpen = new RegExp(`<${DSML_TAG_PATTERN}invoke\\b([^>]*)>`, "gi");
  const invokeClose = new RegExp(`</${DSML_TAG_PATTERN}invoke>`, "i");
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = invokeOpen.exec(block)) !== null) {
    const close = invokeClose.exec(block.slice(invokeOpen.lastIndex));
    if (!close || close.index === undefined) {
      throw new DsmlProtocolError("DSML invoke block is not closed.");
    }
    const bodyStart = invokeOpen.lastIndex;
    const bodyEnd = bodyStart + close.index;
    const body = block.slice(bodyStart, bodyEnd);
    const name = attribute(match[1] ?? "", "name");
    if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      throw new DsmlProtocolError("DSML invoke is missing a valid tool name.");
    }
    calls.push({
      id: `dsml_call_${firstCallNumber + calls.length}`,
      name,
      arguments: parseParameters(body),
    });
    invokeOpen.lastIndex = bodyEnd + close[0].length;
  }

  if (calls.length === 0) throw new DsmlProtocolError("DSML tool-call block contains no invoke.");
  return calls;
}

function parseParameters(body: string): Record<string, unknown> {
  const open = new RegExp(`<${DSML_TAG_PATTERN}parameter\\b([^>]*)>`, "gi");
  const close = new RegExp(`</${DSML_TAG_PATTERN}parameter>`, "i");
  const arguments_: Record<string, unknown> = {};
  let match: RegExpExecArray | null;
  while ((match = open.exec(body)) !== null) {
    const end = close.exec(body.slice(open.lastIndex));
    if (!end || end.index === undefined) throw new DsmlProtocolError("DSML parameter is not closed.");
    const name = attribute(match[1] ?? "", "name");
    if (!name) throw new DsmlProtocolError("DSML parameter is missing a name.");
    if (Object.prototype.hasOwnProperty.call(arguments_, name)) {
      throw new DsmlProtocolError(`DSML parameter is duplicated: ${name}.`);
    }
    const raw = decodeXmlEntities(body.slice(open.lastIndex, open.lastIndex + end.index)).trim();
    const stringValue = attribute(match[1] ?? "", "string");
    arguments_[name] = stringValue === "true" ? raw : parseParameterValue(raw);
    open.lastIndex += end.index + end[0].length;
  }
  return arguments_;
}

function parseParameterValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attributes);
  return match ? decodeXmlEntities(match[2] ?? "") : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function possibleBlockPrefixStart(value: string): number | undefined {
  const minimum = Math.max(0, value.length - Math.max(...BLOCK_START_PREFIXES.map((prefix) => prefix.length)) + 1);
  for (let index = minimum; index < value.length; index += 1) {
    const suffix = value.slice(index);
    if (BLOCK_START_PREFIXES.some((prefix) => prefix.startsWith(suffix))) return index;
  }
  return undefined;
}
