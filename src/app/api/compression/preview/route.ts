import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { compressionPreviewConfigSchema } from "@/shared/validation/compressionConfigSchemas";
import { applyCompression } from "@omniroute/open-sse/services/compression/strategySelector";
import type {
  CompressionConfig,
  CompressionEngineId,
  CompressionMode,
  CompressionPipelineStep,
} from "@omniroute/open-sse/services/compression/types";
import {
  buildCompressionPreviewDiff,
  type HeatmapMode,
} from "@omniroute/open-sse/services/compression/diffHelper";
import { estimateCompressionTokens } from "@omniroute/open-sse/services/compression/stats";
import {
  ensureEngineBreakdown,
  reconcileSingleEngineTokens,
} from "@omniroute/open-sse/services/compression/engineBreakdown";
import { summarizeEncoderCandidates } from "@omniroute/open-sse/services/compression/engines/headroom/encoderComparison";
import { DEFAULT_MIN_ROWS } from "@omniroute/open-sse/services/compression/engines/headroom/smartcrusher";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export const PreviewCompressionConfigSchema = compressionPreviewConfigSchema;

export const PreviewRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.union([z.string(), z.array(z.unknown())]),
      })
    )
    .min(1),
  mode: z
    .enum(["off", "lite", "standard", "aggressive", "ultra", "rtk", "stacked", "caveman"])
    .optional()
    .default("stacked"),
  engineId: z.string().optional(),
  pipeline: z.array(z.string()).min(1).optional(),
  config: PreviewCompressionConfigSchema.optional(),
  // Playground fuzzy near-duplicate toggle → injects `{ fuzzy: { enabled: true } }` into the
  // session-dedup step config.
  fuzzyDedup: z.object({ enabled: z.boolean() }).optional(),
  // riskGate / fidelityGate are unported upstream features in this fork. Accepted for
  // studio-UI request compatibility but intentionally ignored (no effect on compression).
  riskGate: z.object({ enabled: z.boolean() }).optional(),
  fidelityGate: z.object({ enabled: z.boolean() }).optional(),
  // Playground QuantumLock toggle. The studio is a dry-run, so when enabled we force a caching
  // context (provider: "anthropic") so the operator can SEE what would be stabilized.
  quantumLock: z.object({ enabled: z.boolean() }).optional(),
  heatmap: z.enum(["ultra", "universal"]).optional(),
});

const ENGINE_IDS = new Set<CompressionEngineId>([
  "lite",
  "caveman",
  "aggressive",
  "ultra",
  "rtk",
  "relevance",
  "session-dedup",
  "ccr",
  "headroom",
]);

function isEngineId(id: string): id is CompressionEngineId {
  return ENGINE_IDS.has(id as CompressionEngineId);
}

function countTokens(text: string): number {
  return estimateCompressionTokens(text);
}

function messagesToText(messages: Array<{ role: string; content?: unknown }>): string {
  return messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
    })
    .join("\n");
}

function buildStep(
  engine: CompressionEngineId,
  fuzzy?: { enabled: boolean }
): CompressionPipelineStep {
  return engine === "session-dedup" && fuzzy?.enabled
    ? { engine, config: { fuzzy: { enabled: true } } }
    : { engine };
}

/**
 * A single explicit `engineId` or a `pipeline` list is dispatched as a stacked run so the
 * studio can exercise any registered engine (or an ordered combination) through the same
 * synchronous entry point used by the mode path.
 */
function headroomParticipates(
  engineId: string | undefined,
  pipeline: string[] | undefined,
  mode: CompressionMode
): boolean {
  if (engineId) return engineId === "headroom";
  if (pipeline) return pipeline.includes("headroom");
  return mode === "stacked";
}

export async function POST(req: Request) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const {
    messages,
    mode,
    engineId: rawEngineId,
    pipeline: rawPipeline,
    config,
    fuzzyDedup,
    quantumLock,
    heatmap: heatmapMode,
  } = parsed.data;

  // Alias: `mode: "caveman"` is a synonym for `engineId: "caveman"` (single-engine stacked run).
  const engineId = mode === "caveman" && !rawEngineId ? "caveman" : rawEngineId;

  if (engineId && !isEngineId(engineId)) {
    return NextResponse.json({ error: `Unknown engine: "${engineId}"` }, { status: 400 });
  }
  const pipeline = rawPipeline?.filter(isEngineId);
  if (rawPipeline && (!pipeline || pipeline.length === 0)) {
    return NextResponse.json({ error: "No known engines in pipeline" }, { status: 400 });
  }

  const effectiveMode: CompressionMode =
    engineId || pipeline ? "stacked" : (mode as CompressionMode);

  const originalText = messagesToText(messages);
  const originalTokens = countTokens(originalText);

  try {
    const start = Date.now();
    const requestBody = { messages };

    const forceQuantum = quantumLock?.enabled
      ? {
          configPatch: { quantumLock: { enabled: true } } as Partial<CompressionConfig>,
          cachingContext: { provider: "anthropic" as const },
        }
      : { configPatch: {} as Partial<CompressionConfig>, cachingContext: undefined };

    let dispatchConfig: CompressionConfig | undefined;
    if (engineId && isEngineId(engineId)) {
      dispatchConfig = {
        ...(config as CompressionConfig | undefined),
        stackedPipeline: [buildStep(engineId, fuzzyDedup)],
        ...forceQuantum.configPatch,
      } as CompressionConfig;
    } else if (pipeline) {
      dispatchConfig = {
        ...(config as CompressionConfig | undefined),
        stackedPipeline: pipeline.map((engine) => buildStep(engine, fuzzyDedup)),
        ...forceQuantum.configPatch,
      } as CompressionConfig;
    } else {
      dispatchConfig = {
        ...(config as CompressionConfig | undefined),
        ...forceQuantum.configPatch,
      } as CompressionConfig | undefined;
    }

    const result = await applyCompression(requestBody as Record<string, unknown>, effectiveMode, {
      config: dispatchConfig,
      ...(forceQuantum.cachingContext ? { cachingContext: forceQuantum.cachingContext } : {}),
    });
    const durationMs = Date.now() - start;

    const compressedMessages = (result.body.messages ?? messages) as Array<{
      role: string;
      content: unknown;
    }>;
    const compressedText = messagesToText(compressedMessages);
    const compressedTokens = countTokens(compressedText);
    const tokensSaved = Math.max(0, originalTokens - compressedTokens);
    const savingsPct = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;
    const techniquesUsed: string[] = result.stats?.techniquesUsed ?? [];
    const diff = buildCompressionPreviewDiff(
      originalText,
      compressedText,
      result.stats,
      {},
      heatmapMode as HeatmapMode | undefined
    );

    const engineBreakdown = result.stats
      ? reconcileSingleEngineTokens(
          ensureEngineBreakdown(result.stats),
          originalTokens,
          compressedTokens,
          savingsPct
        )
      : [];

    const encoderComparison = headroomParticipates(engineId, pipeline, effectiveMode)
      ? summarizeEncoderCandidates(messages, DEFAULT_MIN_ROWS, countTokens)
      : null;

    const quantumLockStats = result.stats?.quantumLock ?? null;

    return NextResponse.json({
      original: originalText,
      compressed: compressedText,
      originalTokens,
      compressedTokens,
      tokensSaved,
      savingsPct,
      techniquesUsed,
      durationMs,
      engineBreakdown,
      encoderComparison,
      // riskGate is an unported upstream feature in this fork — always null.
      riskGate: null,
      quantumLock: quantumLockStats,
      mode: effectiveMode,
      intensity: null,
      outputMode: null,
      skippedReasons: [],
      diff: diff.segments,
      preservedBlocks: diff.preservedBlocks,
      ruleRemovals: diff.ruleRemovals,
      rulesApplied: diff.ruleRemovals,
      validation: {
        valid: diff.validationErrors.length === 0,
        errors: diff.validationErrors,
        warnings: diff.validationWarnings,
        fallbackApplied: diff.fallbackApplied,
      },
      validationWarnings: diff.validationWarnings,
      validationErrors: diff.validationErrors,
      fallbackApplied: diff.fallbackApplied,
      ...(diff.heatmap ? { heatmap: diff.heatmap } : {}),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/compression/preview]", msg);
    return NextResponse.json(
      { error: "Compression failed", details: sanitizeErrorMessage(msg) },
      { status: 500 }
    );
  }
}
