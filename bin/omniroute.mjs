#!/usr/bin/env node

/**
 * OmniRoute thin entry point.
 *
 * Boots the Next.js server via scripts/dev/run-next.mjs.
 * Usage:
 *   omniroute            Start production server (next start)
 *   omniroute dev        Start development server (next dev)
 */

import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const mode = process.argv[2] === "dev" ? "dev" : "start";
process.argv[2] = mode;
process.chdir(ROOT);

await import(pathToFileURL(join(ROOT, "scripts", "dev", "run-next.mjs")).href);
