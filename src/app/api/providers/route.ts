import { NextResponse } from "next/server";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import {
  getProviderAuditTarget,
  summarizeProviderConnectionForAudit,
} from "@/lib/compliance/providerAudit";
import {
  getProviderConnections,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnections,
  getProviderNodeById,
  isCloudEnabled,
} from "@/models";
import {
  isOpenAICompatibleProvider,
  isMlproxyProvider,
} from "@/shared/constants/providers";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";
import { createProviderSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  normalizeProviderSpecificData,
  sanitizeProviderSpecificDataForResponse,
} from "@/lib/providers/requestDefaults";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isManagedProviderConnectionId } from "@/lib/providers/catalog";
import { isApiKeyRevealEnabled, maskStoredApiKey } from "@/lib/apiKeyExposure";
import {
  resolveMlproxyConfig,
  computeCookieExpiry,
  type MlproxyConfig,
} from "@omniroute/open-sse/executors/mlproxyConfig";
import { getMlproxyDispatcher } from "@omniroute/open-sse/executors/mlproxyAgent";
import { parseSetCookies } from "@omniroute/open-sse/executors/mlproxyCookies";
import { proxyFetch } from "@omniroute/open-sse/utils/proxyFetch";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import pino from "pino";

const logger = pino({ name: "providers-api" });

// GET /api/providers - List all connections
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const connections = await getProviderConnections();
    const revealKeys = isApiKeyRevealEnabled();

    // Hide or mask sensitive fields
    const safeConnections = connections.map((c) => ({
      ...c,
      apiKey: revealKeys ? c.apiKey : c.apiKey ? maskStoredApiKey(c.apiKey) : undefined,
      accessToken: undefined,
      refreshToken: undefined,
      idToken: undefined,
      providerSpecificData: c.providerSpecificData
        ? sanitizeProviderSpecificDataForResponse(c.providerSpecificData)
        : undefined,
    }));

    return NextResponse.json({ connections: safeConnections });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const auditContext = getAuditRequestContext(request);

  try {
    const body = await request.json();

    // Zod validation
    const validation = validateBody(createProviderSchema, body);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      provider,
      apiKey,
      name,
      priority,
      globalPriority,
      defaultModel,
      testStatus,
      providerSpecificData: incomingPsd,
    } = validation.data;

    // Business validation
    const isValidProvider =
      isManagedProviderConnectionId(provider) ||
      isOpenAICompatibleProvider(provider) ||
      isMlproxyProvider(provider);

    if (!isValidProvider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }

    let providerSpecificData = incomingPsd || null;
    const allowMultipleCompatibleConnections =
      process.env.ALLOW_MULTI_CONNECTIONS_PER_COMPAT_NODE === "true";
    let extraConnectionFields: Record<string, unknown> = {};

    // Captured for mlproxy initial login after connection creation
    let mlproxyConfig: MlproxyConfig | null = null;
    let mlproxyPassword: string | null = null;

    if (isOpenAICompatibleProvider(provider)) {
      const node: any = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
      }

      const existingConnections = await getProviderConnections({ provider });
      // Allow multiple connections for compatible nodes exactly like first-party providers

      providerSpecificData = {
        ...(providerSpecificData || {}),
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
        ...(node.chatPath ? { chatPath: node.chatPath } : {}),
        ...(node.modelsPath ? { modelsPath: node.modelsPath } : {}),
        ...(node.mtls ? { mtls: node.mtls } : {}),
      };
    } else if (isMlproxyProvider(provider)) {
      mlproxyConfig = resolveMlproxyConfig(incomingPsd);
      if (!mlproxyConfig) {
        return NextResponse.json(
          { error: "Invalid mlproxy configuration" },
          { status: 400 }
        );
      }

      const password =
        typeof incomingPsd?.password === "string" ? incomingPsd.password.trim() : "";
      if (!password) {
        return NextResponse.json(
          { error: "Password is required for mlproxy" },
          { status: 400 }
        );
      }
      extraConnectionFields = { refreshToken: password };
      mlproxyPassword = password;

      providerSpecificData = {
        login: mlproxyConfig.login,
        baseHost: mlproxyConfig.baseHost,
        proxyId: mlproxyConfig.proxyId,
        refreshIntervalMinutes: mlproxyConfig.refreshIntervalMinutes,
        ...(mlproxyConfig.caPath ? { caPath: mlproxyConfig.caPath } : {}),
        ...(mlproxyConfig.tlsInsecure !== undefined ? { tlsInsecure: mlproxyConfig.tlsInsecure } : {}),
      };
    }

    providerSpecificData = normalizeProviderSpecificData(provider, providerSpecificData) || null;

    const newConnection = await createProviderConnection({
      provider,
      authType: "apikey",
      name,
      apiKey,
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData,
      ...extraConnectionFields,
      isActive: true,
      testStatus: testStatus || "unknown",
    });

    // Note: Gemini model sync is now triggered client-side with progress dialog

    // Hide sensitive fields
    const result: Record<string, any> = { ...newConnection };
    delete result.apiKey;
    if (result.providerSpecificData) {
      result.providerSpecificData = sanitizeProviderSpecificDataForResponse(
        result.providerSpecificData
      );
    }

    // ── MLProxy initial login (seed cookie) ─────────────────────────────────
    // Perform a login round-trip so the connection has a valid cookie before
    // the first chat request. On failure the connection is still created but
    // the response carries a warning flag so the UI can prompt the user.
    if (isMlproxyProvider(provider) && mlproxyConfig && mlproxyPassword) {
      try {
        const authUrl = `${mlproxyConfig.baseHost.replace(/\/$/, "")}/auth`;
        const dispatcher = getMlproxyDispatcher({
          caPath: mlproxyConfig.caPath,
          tlsInsecure: mlproxyConfig.tlsInsecure,
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);

        try {
          const fetchOptions: RequestInit & { dispatcher?: unknown } = {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ login: mlproxyConfig.login, password: mlproxyPassword }),
            dispatcher,
            signal: controller.signal,
          };
          const res = await proxyFetch(authUrl, fetchOptions);

          if (res.ok) {
            const cookie = parseSetCookies(res);
            if (cookie) {
              const expiresAt = computeCookieExpiry(mlproxyConfig.refreshIntervalMinutes);
              await updateProviderConnection(newConnection.id as string, {
                accessToken: cookie,
                expiresAt,
              });
            } else {
              result.needsInitialLogin = true;
            }
          } else {
            result.needsInitialLogin = true;
            logger.info(
              `MLproxy initial login to ${authUrl} returned ${res.status} — connection created without cookie`
            );
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        const message = sanitizeErrorMessage(
          error instanceof Error ? error : new Error(String(error))
        );
        logger.warn(`MLproxy initial login failed: ${message}`);
        result.needsInitialLogin = true;
      }
    }

    // mlproxy: never return accessToken or refreshToken in the response
    if (isMlproxyProvider(provider)) {
      delete result.accessToken;
      delete result.refreshToken;
    }

    // Auto sync to Cloud if enabled
    await syncToCloudIfEnabled();

    logAuditEvent({
      action: "provider.credentials.created",
      actor: "admin",
      target: getProviderAuditTarget(newConnection),
      resourceType: "provider_credentials",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        provider: provider,
        connection: summarizeProviderConnectionForAudit(newConnection),
      },
    });

    return NextResponse.json({ connection: result }, { status: 201 });
  } catch (error) {
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const auditContext = getAuditRequestContext(request);

  let body: { ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json(
      { error: "ids must be a non-empty array of connection IDs" },
      { status: 400 }
    );
  }

  if (body.ids.length > 100) {
    return NextResponse.json(
      { error: "Cannot delete more than 100 connections at once" },
      { status: 400 }
    );
  }

  try {
    const deleted = await deleteProviderConnections(body.ids);

    await syncToCloudIfEnabled();

    logAuditEvent({
      action: "provider.credentials.batch_revoked",
      actor: "admin",
      resourceType: "provider_credentials",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { count: deleted, ids: body.ids },
    });

    return NextResponse.json(
      { message: `Deleted ${deleted} connection(s)`, deleted },
      { status: 200 }
    );
  } catch (error) {
    console.log("Error batch deleting connections:", error);
    return NextResponse.json({ error: "Failed to batch delete connections" }, { status: 500 });
  }
}

/**
 * Sync to Cloud if enabled
 */
async function syncToCloudIfEnabled() {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;

    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing providers to cloud:", error);
  }
}
