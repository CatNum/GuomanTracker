import assert from "node:assert/strict";
import test from "node:test";
import { validDeckSelection, visibleDeckIds } from "../lib/recommendation-deck.ts";

test("selection follows series identity and falls back when a candidate disappears", () => {
  assert.equal(validDeckSelection(["a", "b"], null, "a"), "a");
  assert.equal(validDeckSelection(["b", "a"], "a", "b"), "a");
  assert.equal(validDeckSelection(["b"], "a", "b"), "b");
});

test("deck renders at most five candidates while keeping the selection visible", () => {
  assert.deepEqual(visibleDeckIds([], "a"), []);
  assert.deepEqual(visibleDeckIds(["a"], "a"), ["a"]);
  assert.deepEqual(visibleDeckIds(["a", "b"], "b"), ["a", "b"]);
  const ids = Array.from({ length: 500 }, (_, index) => `item-${index}`);
  assert.deepEqual(visibleDeckIds(ids, "item-0"), ids.slice(0, 5));
  assert.deepEqual(visibleDeckIds(ids, "item-250"), ids.slice(248, 253));
  assert.deepEqual(visibleDeckIds(ids, "item-499"), ids.slice(495));
});
