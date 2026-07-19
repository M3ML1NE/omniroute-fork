// Server startup script
import { enforceWebRuntimeEnv } from "./lib/env/runtimeEnv";
import { enforceSecrets } from "./shared/utils/secretsValidator";
import { initAuditLog, cleanupExpiredLogs, logAuditEvent } from "./lib/compliance/index";
import { initConsoleInterceptor } from "./lib/consoleInterceptor";
import { startBudgetResetJob } from "./lib/jobs/budgetResetJob";
import { startReasoningCacheCleanupJob } from "./lib/jobs/reasoningCacheCleanupJob";
import { getSettings } from "./lib/db/settings";
import { applyRuntimeSettings } from "./lib/config/runtimeSettings";
import { setSystemPromptConfig } from "@omniroute/open-sse/services/systemPrompt.ts";
import { startRuntimeConfigHotReload } from "./lib/config/hotReload";
import { startSpendBatchWriter } from "./lib/spend/batchWriter";
import { registerDefaultGuardrails } from "./lib/guardrails";
import { ensurePersistentManagementPasswordHash } from "./lib/auth/managementPassword";
import { createLogger } from "./shared/utils/logger";
import { clearPool as clearMtlsPool } from "@omniroute/open-sse/services/mtlsAgent.ts";
import { scheduleCapabilityCacheRefresh } from "./lib/providerModels/capabilityCache";

const startupLog = createLogger("server-init");

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function startServer() {
  // Trigger request-log layout migration during startup, before serving requests.
  await import("./lib/usage/migrations");

  // Console interceptor: capture all console output to log file (must be first)
  initConsoleInterceptor();

  // FASE-01: Validate required secrets before anything else (fail-fast)
  enforceSecrets();
  enforceWebRuntimeEnv();

  // Compliance: Initialize audit_log table
  try {
    initAuditLog();
    startupLog.info("Audit log table initialized");
  } catch (err) {
    startupLog.warn({ err }, "Could not initialize audit log");
  }

  // Compliance: One-time cleanup of expired logs
  try {
    const cleanup = await cleanupExpiredLogs();
    if (
      cleanup.deletedUsage ||
      cleanup.deletedCallLogs ||
      cleanup.deletedProxyLogs ||
      cleanup.deletedRequestDetailLogs ||
      cleanup.deletedAuditLogs ||
      cleanup.deletedMcpAuditLogs
    ) {
      startupLog.info({ cleanup }, "Expired log cleanup completed");
    }
  } catch (err) {
    startupLog.warn({ err }, "Log cleanup failed");
  }

  startupLog.info("Starting server");

  try {
    let settings = await getSettings();
    const passwordState = await ensurePersistentManagementPasswordHash({
      logger: { log: (message: string) => startupLog.info(message) },
      settings,
      source: "startup",
    });
    settings = passwordState.settings;
    const runtimeChanges = await applyRuntimeSettings(settings, { force: true, source: "startup" });
    if (runtimeChanges.length > 0) {
      startupLog.info(
        { sections: runtimeChanges.map((entry) => entry.section) },
        "Runtime settings hydrated"
      );
    }

    // Restore the Global System Prompt into the in-memory config. It lives in the
    // `settings.systemPrompt` key but is NOT covered by applyRuntimeSettings, so without
    // this the toggle/prompt revert to defaults on every restart (#2470).
    if (settings.systemPrompt) {
      setSystemPromptConfig(settings.systemPrompt);
      startupLog.info("Global System Prompt restored from settings");
    }

    startSpendBatchWriter();
    registerDefaultGuardrails();
    startupLog.info("Spend batch writer started");
    startupLog.info("Guardrail registry initialized");
    startBudgetResetJob();
    startReasoningCacheCleanupJob();
    startRuntimeConfigHotReload();

    // Warm the capability mirror from the discovery cache (non-blocking).
    scheduleCapabilityCacheRefresh();

    const shutdown = (signal: string) => {
      try {
        clearMtlsPool();
        startupLog.info({ signal }, "mTLS dispatcher pool cleared");
      } catch (err) {
        startupLog.warn({ err: getErrorMessage(err) }, "Error during mTLS pool shutdown");
      }
      process.exit(0);
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

    startupLog.info("Server started");

    // Log server start event to audit log
    logAuditEvent({
      action: "server.start",
      actor: "system",
      target: "server-runtime",
      resourceType: "maintenance",
      status: "success",
      details: { timestamp: new Date().toISOString() },
    });
  } catch (error) {
    startupLog.error({ err: error }, "Error during server startup");
    process.exit(1);
  }

  // Pricing sync removed (GigaChat fork)
}

// Start the server initialization
startServer().catch((err) => {
  startupLog.error({ err }, "Server initialization failed");
  process.exit(1);
});

// Export for use as module if needed
export default startServer;
