import test from "node:test";
import assert from "node:assert/strict";
import { libraryBelongsToUser } from "../lib/library-identity.ts";

test("library belongs to the same authenticated user only when its uid matches", () => {
  assert.equal(libraryBelongsToUser({ user: { uid: "user-a" } }, "user-a"), true);
  assert.equal(libraryBelongsToUser({ user: { uid: "user-b" } }, "user-a"), false);
  assert.equal(libraryBelongsToUser({ user: {} }, "user-a"), false);
  assert.equal(libraryBelongsToUser(null, "user-a"), false);
});
