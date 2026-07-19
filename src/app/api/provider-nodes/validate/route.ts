import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import {
  SAFE_OUTBOUND_FETCH_PRESETS,
  SafeOutboundFetchError,
  getSafeOutboundFetchErrorStatus,
  safeOutboundFetch,
} from "@/shared/network/safeOutboundFetch";
import {
  PROVIDER_URL_BLOCKED_MESSAGE,
  getProviderOutboundGuard,
} from "@/shared/network/outboundUrlGuard";
import { providerNodeValidateSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

function sanitizeAuditBaseUrl(baseUrl: string) {
  if (!baseUrl) return null;
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "") || parsed.origin;
  } catch {
    return baseUrl;
  }
}

// POST /api/provider-nodes/validate - Validate API key against base URL
export async function POST(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const auditContext = getAuditRequestContext(request);
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(providerNodeValidateSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { baseUrl, apiKey } = validation.data;

    // Probe path is hardcoded to /v1/models (sole-source contract; no modelsPath override).
    const normalizedBase = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
    const modelsUrl = `${normalizedBase}/v1/models`;
    const res = await safeOutboundFetch(modelsUrl, {
      ...SAFE_OUTBOUND_FETCH_PRESETS.validationRead,
      guard: getProviderOutboundGuard(),
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    return NextResponse.json({ valid: res.ok, error: res.ok ? null : "Invalid API key" });
  } catch (error) {
    const status = getSafeOutboundFetchErrorStatus(error);
    if (status) {
      const message = error instanceof Error ? error.message : "Validation failed";
      if (
        error instanceof SafeOutboundFetchError &&
        error.code === "URL_GUARD_BLOCKED" &&
        message.includes(PROVIDER_URL_BLOCKED_MESSAGE)
      ) {
        const attemptedBaseUrl =
          rawBody && typeof rawBody === "object" && "baseUrl" in rawBody
            ? String((rawBody as { baseUrl?: unknown }).baseUrl || "")
            : "";
        logAuditEvent({
          action: "provider.validation.ssrf_blocked",
          actor: "admin",
          target: "provider-node",
          resourceType: "provider_validation",
          status: "blocked",
          ipAddress: auditContext.ipAddress || undefined,
          requestId: auditContext.requestId,
          metadata: {
            route: "/api/provider-nodes/validate",
            reason: message,
            baseUrl: sanitizeAuditBaseUrl(attemptedBaseUrl),
          },
        });
      }
      return NextResponse.json({ error: message }, { status });
    }
    console.log("Error validating provider node:", error);
    return NextResponse.json({ error: "Validation failed" }, { status: 500 });
  }
}
