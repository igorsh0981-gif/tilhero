/**
 * Точка входа telegram-bff: конфиг (валидация при старте) → приложение → listen на HOST:PORT (Railway: "::").
 */
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const app = await buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    // Railway требует "::" (приватная сеть по IPv6); на хостах без IPv6 — откат на IPv4, а не падение.
    if ((err as NodeJS.ErrnoException).code !== "EAFNOSUPPORT" || config.host !== "::") throw err;
    app.log.warn("IPv6 is not available, listening on 0.0.0.0");
    await app.listen({ port: config.port, host: "0.0.0.0" });
  }
  app.log.info(
    { port: config.port, env: config.nodeEnv, origins: config.miniappOrigins.length },
    "telegram-bff started",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`telegram-bff failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
