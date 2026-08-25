import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { hostname } from "node:os";
import { createServer, type Server, type Socket } from "node:net";

export class BuddyConfigurationError extends Error {
  readonly code = "buddy_configuration_error";
}

export class BuddyConnectionError extends Error {
  readonly code = "buddy_unavailable";
}

export type BuddyEvent = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  raw: string;
  source: string;
  received_at: string;
};

export type BuddyGatewayConfig = {
  transport: "auto" | "tcp" | "serial";
  serialPort: string | undefined;
  baudRate: number;
  tcpHost: string;
  tcpPort: number;
  tcpClientIp: string | undefined;
  hostName: string;
  eventBufferSize: number;
};

export type BuddyConnectOptions = {
  port?: string | undefined;
  baudRate?: number | undefined;
  transport?: string | undefined;
  tcpHost?: string | undefined;
  tcpPort?: number | undefined;
  tcpClientIp?: string | undefined;
};

export type BuddyGatewayStatus = {
  connected: boolean;
  listening: boolean;
  transport: string | undefined;
  serial_port: string | undefined;
  baud_rate: number | undefined;
  tcp_host: string | undefined;
  tcp_port: number | undefined;
  tcp_client_ip: string | undefined;
  client_address: string | undefined;
  host_name: string;
  recent_event_count: number;
  last_event: BuddyEvent | undefined;
  available_ports: string[];
};

type LineEndpoint = {
  write(data: string): void;
  close(): void;
  onData(listener: (data: Buffer | string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
};

type SerialPortLike = {
  open(callback: (error?: Error | null) => void): void;
  write(data: string, callback?: (error?: Error | null) => void): void;
  close(callback?: (error?: Error | null) => void): void;
  set?(options: { dtr?: boolean; rts?: boolean }, callback?: (error?: Error | null) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

type SerialPortConstructor = new (options: {
  path: string;
  baudRate: number;
  autoOpen: boolean;
}) => SerialPortLike;

const DEFAULT_GATEWAY_CONFIG: BuddyGatewayConfig = {
  transport: "auto",
  serialPort: undefined,
  baudRate: 115_200,
  tcpHost: "127.0.0.1",
  tcpPort: 8766,
  tcpClientIp: undefined,
  hostName: "",
  eventBufferSize: 256,
};

const STATE_COMMANDS: Record<string, string> = {
  connect: "CB connect",
  disconnect: "CB disconnect",
  idle: "CB idle",
  listening: "CB listen",
  thinking: "CB think",
  waiting_user: "CB think",
  speaking: "CB speak",
  stop: "CB stop",
  error: "CB error",
  coding: "CODEX CODING",
  approval: "CODEX APPROVAL codex-hook",
  done: "CODEX DONE",
};

export function defaultBuddyGatewayConfig(): BuddyGatewayConfig {
  return { ...DEFAULT_GATEWAY_CONFIG };
}

/**
 * Node-owned Call Buddy transport. TCP is implemented in the core service;
 * serial is loaded lazily from the optional `serialport` package so a local
 * installation can run without native hardware dependencies.
 */
export class BuddyGateway {
  private readonly config: BuddyGatewayConfig;
  private endpoint: LineEndpoint | undefined;
  private listener: Server | undefined;
  private transport: "tcp" | "serial" | undefined;
  private serialPort: string | undefined;
  private baudRate: number | undefined;
  private tcpHost: string | undefined;
  private tcpPort: number | undefined;
  private tcpClientIp: string | undefined;
  private clientAddress: string | undefined;
  private nextEventId = 1;
  private readonly events: BuddyEvent[];

  constructor(config: Partial<BuddyGatewayConfig> = {}) {
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
    this.events = [];
  }

  async connect(options: BuddyConnectOptions = {}): Promise<BuddyGatewayStatus> {
    const selectedTransport = this.normalizeTransport(options.transport);
    await this.disconnect();
    if (selectedTransport === "tcp") {
      return this.connectTcp(options);
    }
    return this.connectSerial(options);
  }

  async disconnect(): Promise<BuddyGatewayStatus> {
    const endpoint = this.endpoint;
    const listener = this.listener;
    this.endpoint = undefined;
    this.listener = undefined;
    this.transport = undefined;
    this.serialPort = undefined;
    this.baudRate = undefined;
    this.tcpHost = undefined;
    this.tcpPort = undefined;
    this.tcpClientIp = undefined;
    this.clientAddress = undefined;

    if (endpoint) {
      try {
        endpoint.write(`CB disconnect ${this.hostName()} offline\n`);
      } catch {
        // Disconnect is best-effort when the device is already gone.
      }
      endpoint.close();
    }
    if (listener) {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    return this.status();
  }

  status(): BuddyGatewayStatus {
    return {
      connected: this.endpoint !== undefined,
      listening: this.transport === "tcp" && this.listener?.listening === true,
      transport: this.transport,
      serial_port: this.transport === "serial" ? this.serialPort : undefined,
      baud_rate: this.baudRate,
      tcp_host: this.tcpHost,
      tcp_port: this.tcpPort,
      tcp_client_ip: this.tcpClientIp,
      client_address: this.clientAddress,
      host_name: this.hostName(),
      recent_event_count: this.events.length,
      last_event: this.events.at(-1),
      available_ports: this.availablePorts(),
    };
  }

  isConnected(): boolean {
    return this.endpoint !== undefined;
  }

  getEvents(options: { afterId?: number | undefined; limit?: number | undefined } = {}): BuddyEvent[] {
    const afterId = options.afterId;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    return this.events.filter((event) => afterId === undefined || event.id > afterId).slice(-limit);
  }

  sendRawCommand(command: string): BuddyGatewayStatus & { command: string } {
    const normalized = command.trim();
    if (!normalized) throw new BuddyConfigurationError("Buddy command must not be empty.");
    if (/[\r\n\0]/.test(normalized)) throw new BuddyConfigurationError("Buddy command must be a single line.");
    const endpoint = this.endpoint;
    if (!endpoint) throw new BuddyConnectionError("Buddy is not connected.");
    try {
      endpoint.write(`${normalized}\n`);
    } catch (error) {
      throw new BuddyConnectionError(`Failed to send Buddy command: ${errorMessage(error)}`);
    }
    return { command: normalized, ...this.status() };
  }

  setState(state: string, text?: string): BuddyGatewayStatus & { command: string } {
    const normalized = state.trim().toLowerCase();
    const command = STATE_COMMANDS[normalized];
    if (!command) throw new BuddyConfigurationError(`Unsupported Buddy state: ${state}`);
    const suffix = text?.trim() ? ` ${text.trim()}` : "";
    return this.sendRawCommand(`${command}${suffix}`);
  }

  setText(text: string): BuddyGatewayStatus & { command: string } {
    const normalized = text.trim();
    if (!normalized) throw new BuddyConfigurationError("Buddy text must not be empty.");
    return this.sendRawCommand(`TEXT ${normalized}`);
  }

  setCoding(text?: string): BuddyGatewayStatus & { command: string } {
    const suffix = text?.trim() ? ` ${text.trim()}` : "";
    return this.sendRawCommand(`CODEX CODING${suffix}`);
  }

  look(yaw: number, pitch: number, speed?: number): BuddyGatewayStatus & { command: string } {
    const parts = ["LOOK", String(yaw), String(pitch)];
    if (speed !== undefined) parts.push(String(speed));
    return this.sendRawCommand(parts.join(" "));
  }

  setLed(r: number, g: number, b: number, ms?: number): BuddyGatewayStatus & { command: string } {
    const parts = ["LED", String(r), String(g), String(b)];
    if (ms !== undefined) parts.push(String(ms));
    return this.sendRawCommand(parts.join(" "));
  }

  async requestApproval(requestId: string, text: string, timeoutSeconds = 30): Promise<BuddyEvent> {
    const startId = this.events.at(-1)?.id ?? 0;
    this.sendRawCommand(`CODEX APPROVAL ${requestId.trim()} ${text.trim()}`);
    const deadline = Date.now() + Math.max(100, timeoutSeconds * 1_000);
    while (Date.now() < deadline) {
      const event = this.events.find(
        (candidate) => candidate.id > startId
          && candidate.type === "approval.response"
          && String(candidate.payload.id ?? "") === requestId,
      );
      if (event) return event;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    throw new BuddyConnectionError(`Timed out waiting for Buddy approval response: ${requestId}`);
  }

  showApproval(requestId: string, text: string): BuddyGatewayStatus & { command: string } {
    return this.sendRawCommand(`CODEX APPROVAL ${requestId.trim()} ${text.trim()}`);
  }

  private async connectTcp(options: BuddyConnectOptions): Promise<BuddyGatewayStatus> {
    const host = options.tcpHost ?? this.config.tcpHost;
    const port = options.tcpPort ?? this.config.tcpPort;
    const clientIp = options.tcpClientIp ?? this.config.tcpClientIp;
    if (!isLoopbackAddress(host) && !clientIp) {
      throw new BuddyConfigurationError("BUDDY_TCP_CLIENT_IP is required when the Buddy TCP listener is not loopback-only.");
    }
    const server = createServer((socket) => this.acceptTcpClient(socket, clientIp));
    this.listener = server;
    this.transport = "tcp";
    this.tcpHost = host;
    this.tcpPort = port;
    this.tcpClientIp = clientIp;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host, port });
      });
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      this.listener = undefined;
      this.transport = undefined;
      this.tcpHost = undefined;
      this.tcpPort = undefined;
      this.tcpClientIp = undefined;
      throw new BuddyConfigurationError(`Unable to start Buddy TCP listener: ${errorMessage(error)}`);
    }
    const address = server.address();
    if (address && typeof address !== "string") {
      this.tcpHost = address.address;
      this.tcpPort = address.port;
    }
    this.appendEvent("buddy.tcp.listening", { host: this.tcpHost, port: this.tcpPort, client_ip: clientIp }, "tcp-listening", "tcp");
    return this.status();
  }

  private async connectSerial(options: BuddyConnectOptions): Promise<BuddyGatewayStatus> {
    const port = options.port ?? this.config.serialPort ?? this.availablePorts()[0];
    if (!port) {
      throw new BuddyConfigurationError(
        "Buddy serial port is not configured. Set BUDDY_SERIAL_PORT or connect a device at /dev/tty.usbmodem*.",
      );
    }
    const SerialPort = loadSerialPortConstructor();
    const baudRate = options.baudRate ?? this.config.baudRate;
    const serial = new SerialPort({ path: port, baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => serial.open((error) => (error ? reject(error) : resolve())));
    serial.set?.({ dtr: false, rts: false }, () => undefined);
    this.transport = "serial";
    this.serialPort = port;
    this.baudRate = baudRate;
    const endpoint = serialEndpoint(serial);
    this.endpoint = endpoint;
    this.attachEndpoint(endpoint);
    try {
      this.sendRawCommand(`CB connect ${this.hostName()} online`);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
    return this.status();
  }

  private acceptTcpClient(socket: Socket, allowedIp: string | undefined): void {
    const address = socket.remoteAddress ?? "";
    const label = `${address}:${socket.remotePort ?? ""}`;
    if (allowedIp && address !== allowedIp) {
      socket.destroy();
      this.appendEvent("buddy.tcp.rejected", { client_address: label, allowed_client_ip: allowedIp }, label, "tcp");
      return;
    }
    const previous = this.endpoint;
    previous?.close();
    const endpoint = socketEndpoint(socket);
    this.endpoint = endpoint;
    this.clientAddress = label;
    this.attachEndpoint(endpoint);
    this.appendEvent("buddy.tcp.connected", { client_address: label }, label, "tcp");
    try {
      this.sendRawCommand(`CB connect ${this.hostName()} online`);
    } catch (error) {
      this.appendEvent("buddy.connection.error", { error: errorMessage(error), transport: "tcp" }, errorMessage(error), "error");
    }
  }

  private attachEndpoint(endpoint: LineEndpoint): void {
    let buffer = "";
    endpoint.onData((data) => {
      if (this.endpoint !== endpoint) return;
      buffer += typeof data === "string" ? data : data.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.appendParsedLine(line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > 1_000_000) buffer = "";
    });
    endpoint.onError((error) => {
      if (this.endpoint !== endpoint) return;
      this.appendEvent("buddy.connection.error", { error: error.message, transport: this.transport }, error.message, "error");
    });
    endpoint.onClose(() => {
      if (this.endpoint !== endpoint) return;
      this.endpoint = undefined;
      this.clientAddress = undefined;
      this.appendEvent("buddy.disconnected", {}, "closed", "transport");
    });
  }

  private appendParsedLine(line: string): void {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        this.appendEvent("buddy.raw", { json_type: Array.isArray(parsed) ? "array" : typeof parsed, value: parsed }, line, "json");
        return;
      }
      const payload = isRecord(parsed.payload) ? parsed.payload : {};
      const type = typeof parsed.type === "string" && parsed.type.trim() ? parsed.type : "buddy.raw";
      this.appendEvent(type, payload, line, "json");
    } catch {
      this.appendEvent("buddy.raw", {}, line, "text");
    }
  }

  private appendEvent(type: string, payload: Record<string, unknown>, raw: string, source: string): void {
    this.events.push({
      id: this.nextEventId++,
      type,
      payload,
      raw: raw.slice(0, 8_000),
      source,
      received_at: new Date().toISOString(),
    });
    while (this.events.length > Math.max(1, this.config.eventBufferSize)) this.events.shift();
  }

  private availablePorts(): string[] {
    try {
      return readdirSync("/dev")
        .filter((entry) => /^(tty|cu)\.(usbmodem|usbserial)|^(tty|cu)USB/.test(entry))
        .map((entry) => `/dev/${entry}`)
        .sort();
    } catch {
      return [];
    }
  }

  private hostName(): string {
    return this.config.hostName || hostname();
  }

  private normalizeTransport(transport: string | undefined): "tcp" | "serial" {
    const requested = (transport ?? this.config.transport).trim().toLowerCase();
    if (requested === "auto") return this.config.serialPort ? "serial" : "tcp";
    if (requested === "tcp" || requested === "serial") return requested;
    throw new BuddyConfigurationError(`Unsupported Buddy transport: ${transport ?? requested}`);
  }
}

function socketEndpoint(socket: Socket): LineEndpoint {
  return {
    write: (data) => {
      if (socket.destroyed) throw new Error("Buddy TCP socket is closed.");
      socket.write(data);
    },
    close: () => socket.destroy(),
    onData: (listener) => socket.on("data", listener),
    onClose: (listener) => socket.on("close", listener),
    onError: (listener) => socket.on("error", listener),
  };
}

function serialEndpoint(serial: SerialPortLike): LineEndpoint {
  return {
    write: (data) => serial.write(data),
    close: () => serial.close(() => undefined),
    onData: (listener) => serial.on("data", listener as (...args: unknown[]) => void),
    onClose: (listener) => serial.on("close", listener as (...args: unknown[]) => void),
    onError: (listener) => serial.on("error", listener as (...args: unknown[]) => void),
  };
}

function loadSerialPortConstructor(): SerialPortConstructor {
  try {
    const required = createRequire(import.meta.url)("serialport") as {
      SerialPort?: SerialPortConstructor;
      default?: { SerialPort?: SerialPortConstructor };
    };
    const constructor = required.SerialPort ?? required.default?.SerialPort;
    if (constructor) return constructor;
  } catch {
    // Report the actionable installation error below.
  }
  throw new BuddyConfigurationError(
    "Serial transport requires the optional `serialport` package. Install it with `npm install --workspace @anomaloharis/buddy-service serialport`.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackAddress(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
