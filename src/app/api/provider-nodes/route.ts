import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { GIGACHAT_COMPATIBLE_PREFIX, OPENAI_COMPATIBLE_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";
import { createProviderNodeSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const GIGACHAT_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
};

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({
      nodes,
    });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
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
    const validation = validateBody(createProviderNodeSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { name, prefix, apiType, baseUrl, type, chatPath, apiVersion, mtls } = validation.data;

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
        chatPath: chatPath || null,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "gigachat-compatible") {
      if (!mtls) {
        return NextResponse.json({ error: "mTLS certificate paths are required" }, { status: 400 });
      }
      const node = await createProviderNode({
        id: `${GIGACHAT_COMPATIBLE_PREFIX}${generateId()}`,
        type: "gigachat-compatible",
        prefix: prefix.trim(),
        apiType: "chat",
        baseUrl: (baseUrl || GIGACHAT_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
        chatPath: chatPath || null,
        apiVersion: apiVersion || null,
        mtls,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
