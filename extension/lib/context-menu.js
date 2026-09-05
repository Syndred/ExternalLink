// ExternalLink action context menu helpers.
(function (global) {
  "use strict";

  const OPEN_SETTINGS_MENU_ID = "externallink-open-settings";

  function installActionSettingsMenu(chromeApi) {
    if (!chromeApi?.contextMenus) return;
    chromeApi.contextMenus.removeAll(() => {
      chromeApi.contextMenus.create({
        id: OPEN_SETTINGS_MENU_ID,
        title: "打开 ExternalLink 设置",
        contexts: ["action"],
      });
    });
  }

  function handleActionMenuClick(chromeApi, info = {}) {
    if (info.menuItemId !== OPEN_SETTINGS_MENU_ID) return;
    chromeApi?.runtime?.openOptionsPage?.();
  }

  global.ExtLinkContextMenu = {
    OPEN_SETTINGS_MENU_ID,
    installActionSettingsMenu,
    handleActionMenuClick,
  };
})(typeof self !== "undefined" ? self : window);
