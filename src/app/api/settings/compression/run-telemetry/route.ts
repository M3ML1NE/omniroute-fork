// Ported from OmniRoute upstream v3.8.48, adapted for GigaChat fork
//
// GET /api/settings/compression/run-telemetry
// Read-only summary consumed by the CompressionStylesTile on the context settings
// page. Upstream backed this with a dedicated output-style run-telemetry store; that
// subsystem is not part of the GigaChat fork, so this route returns the empty summary
// (the tile renders "No styled runs yet."). Kept as a stable endpoint so the tile has
// something to fetch and degrades cleanly.

import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export const dynamic = "force-dynamic";

const EMPTY_SUMMARY = {
  totalRuns: 0,
  totalTokensSaved: 0,
  runsWithStyles: 0,
  bypassCount: 0,
  totalOutputTokens: 0,
  appliedStyleCounts: {},
};

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(EMPTY_SUMMARY);
}
