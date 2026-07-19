import { registerCompressionEngine, getCompressionEngine } from "./registry.ts";
import { aggressiveEngine, cavemanEngine, liteEngine, ultraEngine } from "./cavemanAdapter.ts";
import { rtkEngine } from "./rtk/index.ts";
import { relevanceEngine } from "./relevance/index.ts";
import { sessionDedupEngine } from "./session-dedup/index.ts";
import { ccrEngine } from "./ccr/index.ts";
import { headroomEngine } from "./headroom/index.ts";
import type { CompressionEngine } from "./types.ts";

let registered = false;

export function registerBuiltinCompressionEngines(): void {
  if (registered) return;
  registered = true;

  if (!getCompressionEngine(liteEngine.id)) registerCompressionEngine(liteEngine);

  const engines: Array<{ id: string; engine: CompressionEngine }> = [
    { id: "caveman", engine: cavemanEngine },
    { id: "aggressive", engine: aggressiveEngine },
    { id: "ultra", engine: ultraEngine },
    { id: "rtk", engine: rtkEngine },
    { id: "relevance", engine: relevanceEngine },
    { id: "session-dedup", engine: sessionDedupEngine },
    { id: "ccr", engine: ccrEngine },
    { id: "headroom", engine: headroomEngine },
  ];

  for (const { id, engine } of engines) {
    if (!getCompressionEngine(id)) registerCompressionEngine(engine);
  }
}
