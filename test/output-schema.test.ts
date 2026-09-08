import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchema, extractStructuredOutput } from "../pi-extension/subagents/output-schema.ts";

test("validateJsonSchema: null schema = no validation (always passes)", () => {
  assert.equal(validateJsonSchema({ foo: 1 }, null), null);
  assert.equal(validateJsonSchema("anything", undefined), null);
});

test("validateJsonSchema: basic type checking", () => {
  assert.equal(validateJsonSchema("hello", { type: "string" }), null);
  assert.ok(validateJsonSchema(42, { type: "string" }) !== null);
  assert.equal(validateJsonSchema(42, { type: "number" }), null);
  assert.equal(validateJsonSchema(true, { type: "boolean" }), null);
  assert.equal(validateJsonSchema({}, { type: "object" }), null);
  assert.equal(validateJsonSchema([], { type: "array" }), null);
  assert.equal(validateJsonSchema(null, { type: "null" }), null);
});

test("validateJsonSchema: integer type rejects floats", () => {
  assert.equal(validateJsonSchema(42, { type: "integer" }), null);
  assert.ok(validateJsonSchema(3.14, { type: "integer" }) !== null);
});

test("validateJsonSchema: required properties", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name"],
  };
  assert.equal(validateJsonSchema({ name: "Alice" }, schema), null);
  assert.ok(validateJsonSchema({}, schema) !== null);
});

test("validateJsonSchema: additionalProperties false", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  assert.equal(validateJsonSchema({ name: "Alice" }, schema), null);
  assert.ok(validateJsonSchema({ name: "Alice", extra: 1 }, schema) !== null);
});

test("validateJsonSchema: array items", () => {
  const schema = {
    type: "array",
    items: { type: "string" },
  };
  assert.equal(validateJsonSchema(["a", "b"], schema), null);
  assert.ok(validateJsonSchema(["a", 1], schema) !== null);
});

test("validateJsonSchema: enum", () => {
  const schema = { type: "string", enum: ["red", "green", "blue"] };
  assert.equal(validateJsonSchema("red", schema), null);
  assert.ok(validateJsonSchema("purple", schema) !== null);
});

test("validateJsonSchema: oneOf (exactly one must match)", () => {
  const schema = {
    oneOf: [
      { type: "string" },
      { type: "number" },
    ],
  };
  assert.equal(validateJsonSchema("hello", schema), null);
  assert.equal(validateJsonSchema(42, schema), null);
  // null matches neither, so it's valid (zero matches)
  assert.ok(validateJsonSchema(null, schema) !== null);
});

test("validateJsonSchema: anyOf (at least one must match)", () => {
  const schema = {
    anyOf: [
      { type: "string" },
      { type: "number" },
    ],
  };
  assert.equal(validateJsonSchema("hello", schema), null);
  assert.equal(validateJsonSchema(42, schema), null);
  assert.ok(validateJsonSchema(true, schema) !== null);
});

test("validateJsonSchema: nested object", () => {
  const schema = {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", minimum: 0 },
        },
        required: ["name"],
      },
    },
    required: ["user"],
  };
  assert.equal(validateJsonSchema({ user: { name: "Alice", age: 30 } }, schema), null);
  assert.ok(validateJsonSchema({ user: { age: 30 } }, schema) !== null);
  assert.ok(validateJsonSchema({ user: { name: "Alice", age: -5 } }, schema) !== null);
});

test("validateJsonSchema: string constraints", () => {
  assert.ok(validateJsonSchema("ab", { type: "string", minLength: 3 }) !== null);
  assert.equal(validateJsonSchema("abc", { type: "string", minLength: 3 }), null);
  assert.ok(validateJsonSchema("abcd", { type: "string", maxLength: 3 }) !== null);
});

test("validateJsonSchema: number constraints", () => {
  assert.ok(validateJsonSchema(5, { type: "number", minimum: 10 }) !== null);
  assert.equal(validateJsonSchema(15, { type: "number", minimum: 10 }), null);
  assert.ok(validateJsonSchema(15, { type: "number", maximum: 10 }) !== null);
});

test("extractStructuredOutput: parse raw JSON", () => {
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const result = extractStructuredOutput('{"name": "Alice"}', schema);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: any }).value, { name: "Alice" });
});

test("extractStructuredOutput: parse fenced JSON block", () => {
  const schema = { type: "object", properties: { x: { type: "number" } }, required: ["x"] };
  const msg = "Here is the result:\n```json\n{\"x\": 42}\n```\nDone.";
  const result = extractStructuredOutput(msg, schema);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: any }).value, { x: 42 });
});

test("extractStructuredOutput: parse bare JSON block (no language tag)", () => {
  const schema = { type: "object", properties: { y: { type: "string" } }, required: ["y"] };
  const msg = "Result:\n```\n{\"y\": \"hello\"}\n```";
  const result = extractStructuredOutput(msg, schema);
  assert.equal(result.ok, true);
});

test("extractStructuredOutput: parse first { ... } substring", () => {
  const schema = { type: "object", properties: { z: { type: "boolean" } }, required: ["z"] };
  const msg = 'The answer is {"z": true} as shown above.';
  const result = extractStructuredOutput(msg, schema);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: any }).value, { z: true });
});

test("extractStructuredOutput: validation failure returns error", () => {
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const result = extractStructuredOutput('{"age": 30}', schema);
  assert.equal(result.ok, false);
  assert.ok((result as { ok: false; error: string }).error.includes("name"));
});

test("extractStructuredOutput: no JSON in message", () => {
  const schema = { type: "object" };
  const result = extractStructuredOutput("Just plain text, no JSON here.", schema);
  assert.equal(result.ok, false);
  assert.ok((result as { ok: false; error: string }).error.includes("parseable"));
});
