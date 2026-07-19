import { NextResponse } from "next/server";
import {
  deleteProviderConnectionsByProvider,
  deleteProviderNode,
  getProviderConnections,
  getProviderNodeById,
  updateProviderConnection,
  updateProviderNode,
} from "@/models";
import { updateProviderNodeSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const { id } = await params;
    const validation = validateBody(updateProviderNodeSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { name, prefix, apiType, baseUrl, chatPath, apiVersion, mtls } = validation.data;
    const node: any = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    // Only validate apiType for OpenAI Compatible nodes
    const validApiTypes = [
      "chat",
      "responses",
      "embeddings",
      "audio-transcriptions",
      "audio-speech",
      "images-generations",
    ];
    if (node.type === "openai-compatible" && (!apiType || !validApiTypes.includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (node.type === "openai-compatible" && apiVersion !== undefined) {
      return NextResponse.json(
        { error: "apiVersion is only supported on GigaChat-compatible providers" },
        { status: 400 }
      );
    }

    const sanitizedBaseUrl = baseUrl.trim();

    const updates: Record<string, unknown> = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
      chatPath: chatPath || null,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }
    if (node.type === "gigachat-compatible") {
      if (mtls) {
        updates.mtls = mtls;
      }
      updates.apiVersion = apiVersion || null;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(
      connections.flatMap((connectionRaw) => {
        const connection = asRecord(connectionRaw);
        const connectionId = typeof connection.id === "string" ? connection.id : "";
        if (!connectionId) return [];

        const providerSpecificData = {
          ...asRecord(connection.providerSpecificData),
          prefix: prefix.trim(),
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
          chatPath: updated.chatPath || undefined,
        } as JsonRecord;
        delete providerSpecificData.modelsPath;
        if (node.type === "openai-compatible") {
          providerSpecificData.apiType = apiType;
        }
        if (updated.mtls) {
          providerSpecificData.mtls = updated.mtls;
        }
        if (node.type === "gigachat-compatible") {
          if (updated.apiVersion) {
            providerSpecificData.apiVersion = updated.apiVersion;
          } else {
            delete providerSpecificData.apiVersion;
          }
        }

        return [
          updateProviderConnection(connectionId, {
            providerSpecificData,
          }),
        ];
      })
    );

    return NextResponse.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
