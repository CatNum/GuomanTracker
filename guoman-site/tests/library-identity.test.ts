import test from "node:test";
import assert from "node:assert/strict";
import { readVerifiedLibrary } from "../lib/library-identity.ts";

test("刷新账号库时要求SDK首尾会话和库归属一致，并返回末次可信邮箱", async () => {
  const sessions = [
    { userId: "alice", email: "old@example.com" },
    { userId: "alice", email: "alice@example.com" },
  ];
  let requestedUserId = "";
  const result = await readVerifiedLibrary(
    async () => sessions.shift() || null,
    async (expectedUserId) => { requestedUserId = expectedUserId; return { user: { uid: "alice" }, follows: [] }; },
  );
  assert.equal(requestedUserId, "alice");
  assert.equal(result?.library.user.uid, "alice");
  assert.equal(result?.session.email, "alice@example.com");
});

test("SDK会话跨账号变化或返回另一账号的库时拒绝刷新", async () => {
  const changedSession = [
    { userId: "alice" },
    { userId: "bob" },
  ];
  await assert.rejects(
    () => readVerifiedLibrary(async () => changedSession.shift() || null, async () => ({ user: { uid: "alice" } })),
    /账号会话已变化/,
  );
  await assert.rejects(
    () => readVerifiedLibrary(async () => ({ userId: "alice" }), async () => ({ user: { uid: "bob" } })),
    /账号会话已变化/,
  );
});

test("组件代次失效后停止，不再读取第二次会话", async () => {
  let sessionReads = 0;
  let current = true;
  const result = await readVerifiedLibrary(
    async () => { sessionReads++; return { userId: "alice" }; },
    async () => { current = false; return { user: { uid: "alice" } }; },
    () => current,
  );
  assert.equal(result, null);
  assert.equal(sessionReads, 1);
});
