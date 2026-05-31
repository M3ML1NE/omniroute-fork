import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isMinimalDb, nonCriticalDbDisabled } from "../../../src/lib/db/minimalDb.js";

describe("minimalDb flag", () => {
  const orig = process.env["OMNIROUTE_MINIMAL_DB"];

  afterEach(() => {
    if (orig === undefined) delete process.env["OMNIROUTE_MINIMAL_DB"];
    else process.env["OMNIROUTE_MINIMAL_DB"] = orig;
  });

  it("defaults to true (enabled) when unset", () => {
    delete process.env["OMNIROUTE_MINIMAL_DB"];
    assert.equal(isMinimalDb(), true);
  });

  it("false when explicitly 'false'", () => {
    process.env["OMNIROUTE_MINIMAL_DB"] = "false";
    assert.equal(isMinimalDb(), false);
  });

  it("false when '0'", () => {
    process.env["OMNIROUTE_MINIMAL_DB"] = "0";
    assert.equal(isMinimalDb(), false);
  });

  it("true when 'true'", () => {
    process.env["OMNIROUTE_MINIMAL_DB"] = "true";
    assert.equal(isMinimalDb(), true);
  });

  it("nonCriticalDbDisabled mirrors isMinimalDb", () => {
    delete process.env["OMNIROUTE_MINIMAL_DB"];
    assert.equal(nonCriticalDbDisabled(), isMinimalDb());

    process.env["OMNIROUTE_MINIMAL_DB"] = "false";
    assert.equal(nonCriticalDbDisabled(), isMinimalDb());
  });
});
