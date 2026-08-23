import { settingsFromEnv, startBuddyService } from "./service.js";

const settings = settingsFromEnv();
const { service, server } = await startBuddyService(settings);
console.info(`Buddy Node service listening on http://${settings.host}:${settings.port}`);

const shutdown = async () => {
  await service.gateway.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
