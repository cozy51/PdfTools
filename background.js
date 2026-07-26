"use strict";

async function openEditorTab() {
  const editorUrl = chrome.runtime.getURL("editor.html");

  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["TAB"],
        documentUrls: [editorUrl]
      });
      const existing = contexts.find((context) => Number.isInteger(context.tabId));
      if (existing) {
        await chrome.tabs.update(existing.tabId, { active: true });
        if (Number.isInteger(existing.windowId)) {
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return;
      }
    } catch {
      // Older Edge versions may not support runtime.getContexts.
    }
  }

  await chrome.tabs.create({ url: editorUrl });
}

chrome.action.onClicked.addListener(() => {
  void openEditorTab().catch(() => {});
});
