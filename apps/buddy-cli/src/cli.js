#!/usr/bin/env node

import { realpath, writeFile as writeFileToDisk } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 29_000;

export async function runBuddyCli(argv, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeFile = options.writeFile ?? writeFileToDisk;
  const baseUrl = (env.BUDDY_SERVICE_URL || env.ANOMALOHARIS_BUDDY_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/$/, "");
  const token = env.BUDDY_SERVICE_TOKEN || env.ANOMALOHARIS_BUDDY_SERVICE_TOKEN || "";
  const timeoutMs = boundedNumber(env.BUDDY_REQUEST_TIMEOUT_MS || env.ANOMALOHARIS_BUDDY_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const [command, ...arguments_] = argv;

  if (command === "status") {
    const { json } = parseFlags(arguments_, new Set(["--json"]));
    const status = await requestJson(fetchImpl, baseUrl, token, timeoutMs, "/v1/buddy/status");
    stdout(json ? JSON.stringify(status, null, 2) : formatStatus(status));
    return status;
  }

  if (command === "capabilities") {
    const { json } = parseFlags(arguments_, new Set(["--json"]));
    const status = await requestJson(fetchImpl, baseUrl, token, timeoutMs, "/v1/buddy/status");
    const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
    stdout(json ? JSON.stringify(capabilities, null, 2) : formatCapabilities(capabilities));
    return capabilities;
  }

  if (command === "home") {
    const { json } = parseFlags(arguments_, new Set(["--json"]));
    return invoke(fetchImpl, writeFile, stdout, baseUrl, token, timeoutMs, "head.home", {}, undefined, json);
  }

  if (command === "look") {
    const [direction, ...tail] = arguments_;
    const pans = { left: -45, center: 0, right: 45 };
    if (!Object.hasOwn(pans, direction)) throw new Error("Usage: buddy look left|center|right [--tilt DEGREES] [--json]");
    const parsed = parseFlags(tail, new Set(["--json"]), new Set(["--tilt", "--speed", "--move-time-ms"]));
    const args = {
      pan: pans[direction],
      ...(parsed.values.has("--tilt") ? { tilt: parseNumberOption("--tilt", parsed.values.get("--tilt")) } : {}),
      ...(parsed.values.has("--speed") ? { speed: parseNumberOption("--speed", parsed.values.get("--speed")) } : {}),
      ...(parsed.values.has("--move-time-ms") ? { moveTimeMs: parseNumberOption("--move-time-ms", parsed.values.get("--move-time-ms")) } : {}),
    };
    return invoke(fetchImpl, writeFile, stdout, baseUrl, token, timeoutMs, "head.move", args, undefined, parsed.json);
  }

  if (command === "observe") {
    const parsed = parseFlags(arguments_, new Set(["--json"]), new Set(["--direction", "--tilt", "--settle-ms", "--out"]));
    const args = {
      direction: parsed.values.get("--direction") || "center",
      ...(parsed.values.has("--tilt") ? { tilt: parseNumberOption("--tilt", parsed.values.get("--tilt")) } : {}),
      ...(parsed.values.has("--settle-ms") ? { settleMs: parseNumberOption("--settle-ms", parsed.values.get("--settle-ms")) } : {}),
    };
    if (!["left", "center", "right"].includes(args.direction)) {
      throw new Error("--direction must be left, center, or right.");
    }
    return invoke(fetchImpl, writeFile, stdout, baseUrl, token, timeoutMs, "head.observe", args, parsed.values.get("--out"), parsed.json);
  }

  if (command === "invoke") {
    const [capability, ...tail] = arguments_;
    if (!capability || capability.startsWith("--")) throw new Error("Usage: buddy invoke <capability> [--args JSON] [--out FILE] [--json]");
    const parsed = parseFlags(tail, new Set(["--json"]), new Set(["--args", "--out"]));
    let args = {};
    if (parsed.values.has("--args")) {
      try {
        args = JSON.parse(parsed.values.get("--args"));
      } catch {
        throw new Error("--args must contain valid JSON.");
      }
      if (!args || Array.isArray(args) || typeof args !== "object") {
        throw new Error("--args must decode to a JSON object.");
      }
    }
    return invoke(fetchImpl, writeFile, stdout, baseUrl, token, timeoutMs, capability, args, parsed.values.get("--out"), parsed.json);
  }

  throw new Error("Unknown Buddy command. Use status, capabilities, look, home, observe, or invoke.");
}

async function invoke(fetchImpl, writeFile, stdout, baseUrl, token, timeoutMs, capability, args, outputPath, json) {
  const response = await requestJson(fetchImpl, baseUrl, token, timeoutMs, "/v1/buddy/invoke", {
    method: "POST",
    body: JSON.stringify({ capability, args }),
  });
  const safeResponse = structuredClone(response);
  const image = safeResponse.result?.image;
  if (image) {
    if (outputPath) {
      if (typeof image.data !== "string") throw new Error("Buddy returned an image without base64 data.");
      await writeFile(outputPath, Buffer.from(image.data, "base64"));
      delete image.data;
      image.path = outputPath;
    } else {
      delete image.data;
      image.dataOmitted = true;
    }
  }
  stdout(json ? JSON.stringify(safeResponse, null, 2) : formatInvocation(safeResponse));
  return safeResponse;
}

async function requestJson(fetchImpl, baseUrl, token, timeoutMs, path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body ? { body: options.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Buddy returned invalid JSON.");
  }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Buddy returned HTTP ${response.status}.`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Buddy returned an unexpected response.");
  }
  return payload;
}

function parseFlags(arguments_, booleanFlags, valueFlags = new Set()) {
  const values = new Map();
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (booleanFlags.has(flag)) {
      if (flag === "--json") json = true;
      continue;
    }
    if (valueFlags.has(flag)) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      values.set(flag, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
  return { json, values };
}

function formatStatus(status) {
  const connection = status.connected ? "online" : "offline";
  const state = typeof status.state === "string" ? status.state : status.state?.name || status.state?.phase || "unknown";
  const count = Array.isArray(status.capabilities) ? status.capabilities.length : 0;
  return `Buddy ${connection}${status.deviceId ? ` · ${status.deviceId}` : ""} · ${state} · ${count} capabilities`;
}

function formatCapabilities(capabilities) {
  if (!capabilities.length) return "Buddy reports no capabilities.";
  return capabilities.map((capability) => {
    const access = capability.effectiveAllowed ?? capability.allowed;
    return `${access ? "allowed" : "blocked"}  ${capability.name} — ${capability.description || ""}`.trimEnd();
  }).join("\n");
}

function formatInvocation(response) {
  return JSON.stringify(response, null, 2);
}

function parseNumberOption(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`);
  return number;
}

function boundedNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 100 ? Math.min(value, 129_000) : fallback;
}

const invokedScript = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))
  : "";
const moduleScript = await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));

if (invokedScript === moduleScript) {
  runBuddyCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
