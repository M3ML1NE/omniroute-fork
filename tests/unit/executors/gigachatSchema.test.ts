import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGigaChatToolSchema } from "../../../open-sse/executors/gigachatSchema.ts";

type JsonRecord = Record<string, unknown>;

describe("normalizeGigaChatToolSchema", () => {
  it("adds empty properties to a nested object that omits it (the 422 fix)", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: { inline: { type: "object" } },
      required: ["inline"],
    });
    const inline = (out.properties as JsonRecord).inline as JsonRecord;
    assert.deepEqual(inline.properties, {}, "inline.properties must exist");
    assert.equal(inline.type, "object");
  });

  it("infers object type and properties for an untyped property schema", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: { args: { description: "x" } },
    });
    const args = (out.properties as JsonRecord).args as JsonRecord;
    assert.equal(args.type, "object");
    assert.deepEqual(args.properties, {});
    assert.equal(args.description, "x", "metadata preserved");
  });

  it("fills properties on object-typed array items", () => {
    const out = normalizeGigaChatToolSchema({ type: "array", items: { type: "object" } });
    const items = out.items as JsonRecord;
    assert.equal(items.type, "object");
    assert.deepEqual(items.properties, {});
  });

  it("defaults missing array items to a string schema", () => {
    const out = normalizeGigaChatToolSchema({ type: "array" });
    assert.deepEqual(out.items, { type: "string" });
  });

  it("inlines $ref/$defs and removes the $defs block", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: { resp: { items: { $ref: "#/$defs/F" }, type: "array" } },
      required: ["resp"],
      $defs: { F: { type: "object", properties: { n: { type: "string" } } } },
    });
    assert.ok(!("$defs" in out), "$defs removed");
    const items = ((out.properties as JsonRecord).resp as JsonRecord).items as JsonRecord;
    assert.equal(items.type, "object");
    assert.equal((items.properties as JsonRecord).n !== undefined, true, "ref inlined");
  });

  it("flattens anyOf with a null variant and preserves metadata", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: { city: { anyOf: [{ type: "string" }, { type: "null" }], description: "c" } },
    });
    const city = (out.properties as JsonRecord).city as JsonRecord;
    assert.equal(city.type, "string");
    assert.equal(city.description, "c");
    assert.ok(!("anyOf" in city), "anyOf removed");
  });

  it("collapses a type array [string, null] to the first non-null type", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: { x: { type: ["string", "null"] } },
    });
    assert.equal(((out.properties as JsonRecord).x as JsonRecord).type, "string");
  });

  it("strips unsupported format values but keeps date/date-time/time", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        d: { type: "string", format: "date" },
      },
    });
    const props = out.properties as JsonRecord;
    assert.ok(!("format" in (props.id as JsonRecord)), "uuid format stripped");
    assert.equal((props.d as JsonRecord).format, "date", "date format kept");
  });

  it("returns an empty object schema for null/invalid input", () => {
    assert.deepEqual(normalizeGigaChatToolSchema(null), { type: "object", properties: {} });
    assert.deepEqual(normalizeGigaChatToolSchema("nope" as unknown), {
      type: "object",
      properties: {},
    });
  });

  it("filters required[] down to string keys", () => {
    const out = normalizeGigaChatToolSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", 5, null],
    });
    assert.deepEqual(out.required, ["a"]);
  });
});
