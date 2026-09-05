import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { self: {} };
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/context-menu.js", "utf8"), context);

const M = context.self.ExtLinkContextMenu;
const calls = [];
const fakeChrome = {
  contextMenus: {
    removeAll(callback) {
      calls.push({ type: "removeAll" });
      callback();
    },
    create(item) {
      calls.push({ type: "create", item: JSON.parse(JSON.stringify(item)) });
    },
  },
  runtime: {
    openOptionsPage() {
      calls.push({ type: "openOptionsPage" });
    },
  },
};

M.installActionSettingsMenu(fakeChrome);
assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
  { type: "removeAll" },
  {
    type: "create",
    item: {
      id: "externallink-open-settings",
      title: "打开 ExternalLink 设置",
      contexts: ["action"],
    },
  },
]);

M.handleActionMenuClick(fakeChrome, { menuItemId: "unrelated" });
assert.equal(calls.filter((call) => call.type === "openOptionsPage").length, 0);

M.handleActionMenuClick(fakeChrome, { menuItemId: "externallink-open-settings" });
assert.equal(
  calls.filter((call) => call.type === "openOptionsPage").length,
  1,
  "right-clicking the pinned extension action should open settings directly",
);

console.log("context menu tests passed");
