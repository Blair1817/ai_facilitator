import assert from "node:assert/strict";
import test from "node:test";

import { verifyTajribaText } from "./verify-tajriba-integrity.mjs";

const gameId = "01M02EE6ZYRTKA2AFE46AW17ZX";
const groupId = "01M02EE70FGPM5E94X1XFFP7PJ";
const serviceId = "01KZZ8PK3Y95AZMG346YDQ2M97";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function healthyRows() {
  return [
    { version: "test" },
    { kind: "Service", obj: { id: serviceId } },
    { kind: "Scope", obj: { id: gameId, kind: "game", createdByID: serviceId } },
    { kind: "Group", obj: { id: groupId, createdByID: serviceId } },
    {
      kind: "Attribute",
      obj: {
        id: "01M02ATTRIBUTE0000000000000",
        nodeID: gameId,
        key: "groupID",
        val: JSON.stringify(groupId),
      },
    },
  ];
}

test("accepts a store whose entity references all resolve", () => {
  const result = verifyTajribaText(jsonl(healthyRows()));
  assert.deepEqual(result.parseErrors, []);
  assert.deepEqual(result.dangling, []);
});

test("detects the missing Group pattern that caused the participant white screen", () => {
  const rows = healthyRows().filter((row) => row.kind !== "Group");
  const result = verifyTajribaText(jsonl(rows));
  assert.equal(result.dangling.length, 1);
  assert.equal(result.dangling[0].kind, "Attribute");
  assert.equal(result.dangling[0].field, "val");
});

test("detects malformed JSONL without exposing its content", () => {
  const result = verifyTajribaText('{"kind":"Scope"\n');
  assert.deepEqual(result.parseErrors, [1]);
});
