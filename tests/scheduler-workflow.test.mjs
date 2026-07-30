import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadSchedulerModule() {
  const context = { self: {}, console };
  vm.createContext(context);
  vm.runInContext(readFileSync("extension/lib/scheduler.js", "utf8"), context);
  return context.self.ExtLinkScheduler;
}

const S = loadSchedulerModule();

{
  const groups = S.groupTasksByDestination([
    { id: "d::B", destinationGroupKey: "d", profileId: "B", index: 1, status: "pending" },
    { id: "d::C", destinationGroupKey: "d", profileId: "C", index: 2, status: "pending" },
    { id: "e::B", destinationGroupKey: "e", profileId: "B", index: 3, status: "pending" },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(groups.map((group) => group.tasks.map((task) => task.profileId)))),
    [
      ["B", "C"],
      ["B"],
    ],
  );
}

{
  const parkedOnly = new Map([[1, { slotActive: false, agentPaused: true }]]);
  const queue = [{ key: "next-destination", tasks: [{ status: "pending" }] }];
  assert.equal(S.countProcessingSlots(parkedOnly), 0);
  assert.equal(
    S.countProcessingSlots(parkedOnly) < 1 && queue.length > 0,
    true,
    "with concurrency 1, a parked login/captcha tab must allow the next destination to launch",
  );
}

{
  const entries = new Map([
    [1, { slotActive: true }],
    [2, { slotActive: false, agentPaused: true }],
    [3, { slotActive: true }],
  ]);
  assert.equal(
    S.countProcessingSlots(entries),
    2,
    "parked tabs should not consume a processing slot",
  );
}

{
  const group = {
    tasks: [
      { index: 1, status: "ok", profileId: "B" },
      { index: 2, status: "pending", profileId: "C" },
    ],
  };
  assert.equal(S.nextPendingTask(group, 1).profileId, "C");
  group.tasks[1].status = "skip";
  assert.equal(S.nextPendingTask(group, 1), null);
}

{
  const groups = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.equal(S.resolveCursorIndex(groups, "b", 1, 1), 2);

  const afterRemovingB = [{ key: "a" }, { key: "c" }];
  assert.equal(
    S.resolveCursorIndex(afterRemovingB, "b", 1, 1),
    1,
    "when the current destination disappeared, the item that slid into its index is next",
  );
}

{
  const restored = S.buildRestoredQueue(
    [
      {
        key: "d",
        tasks: [
          { id: "d::B", status: "needs_manual" },
          { id: "d::C", status: "pending" },
        ],
      },
      { key: "e", tasks: [{ id: "e::B", status: "pending" }] },
    ],
    ["d::B"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.map((group) => group.key))),
    ["e"],
    "restoring a parked destination must not reopen its sibling before manual recovery",
  );
}

console.log("scheduler workflow tests passed");
