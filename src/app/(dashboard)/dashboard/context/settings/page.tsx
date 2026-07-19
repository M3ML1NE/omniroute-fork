"use client";

// Ported from OmniRoute upstream v3.8.48 (GigaChat fork). Renders the real engine-grid
// CompressionPanel (adapted: no adaptiveCompression / SLM tier) plus the read-only
// output-style telemetry tile below it, exactly as upstream did.

import CompressionPanel from "./CompressionPanel";
import CompressionStylesTile from "../CompressionStylesTile";

export default function CompressionSettingsPage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <CompressionPanel />
      {/* Read-only telemetry tile (output-token savings + applied styles) */}
      <CompressionStylesTile />
    </div>
  );
}
