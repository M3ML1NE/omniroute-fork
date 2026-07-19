import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const removedModulePath = path.join(process.cwd(), "src/lib/versionManager/binaryManager.ts");

test("binaryManager module remains deleted with the versionManager subsystem", () => {
  assert.equal(fs.existsSync(removedModulePath), false);
});
