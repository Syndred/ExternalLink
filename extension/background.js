// ExternalLink Extension - Background Orchestrator
'use strict';

let state = {
  running: false,
  tasks: [],
  config: null,
  queue: [],
  activeTabs: new Map(), // tabId -> taskIndex
  concurrency: 3,
  stopped: false,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'start':
      state.config = msg.config;
      state.tasks = msg.tasks;
      state.queue = [...msg.tasks];
      state.concurrency = msg.config.concurrency;
      state.running = true;
      state.stopped = false;
      broadcastStatus();
      log('开始处理 ' + state.tasks.length + ' 个任务', 'ok');
      processQueue();
      break;
    case 'stop':
      state.stopped = true;
      state.running = false;
      closeAllTabs();
      broadcastStatus();
      log('任务已停止', 'warn');
      break;
    case 'contentReady':
      handleContentReady(sender.tab, msg);
      break;
    case 'captchaResolved':
      resumeAfterCaptcha(sender.tab.id, msg);
      break;
  }
});

// ─── Queue Processing ───
async function processQueue() {
  while (state.running && state.queue.length > 0 && !state.stopped) {
    while (state.activeTabs.size < state.concurrency && state.queue.length > 0) {
      const task = state.queue.shift();
      processOne(task);
    }
    await sleep(500);
  }
  if (state.queue.length === 0 && state.activeTabs.size === 0) {
    state.running = false;
    broadcastStatus();
    log('✅ 所有任务处理完毕', 'ok');
  }
}

async function processOne(task) {
  try {
    const url = task.url.startsWith('http') ? task.url : 'https://' + task.url;
    task.status = 'running';
    broadcastTaskUpdate(task);

    const tab = await chrome.tabs.create({ url, active: false });
    state.activeTabs.set(tab.id, task.index);

    // Wait for page load (content script will send contentReady)
    setTimeout(() => {
      if (state.activeTabs.has(tab.id)) {
        // Timeout - skip this task
        handleTimeout(tab.id);
      }
    }, 45000);
  } catch (err) {
    log(`创建标签页失败: ${task.domain} - ${err.message}`, 'err');
    task.status = 'err';
    broadcastTaskUpdate(task);
  }
}

// ─── Content Script Callbacks ───
async function handleContentReady(tab, data) {
  const taskIndex = state.activeTabs.get(tab.id);
  if (!taskIndex) return;
  const task = state.tasks.find(t => t.index === taskIndex);
  if (!task) return;

  log(`页面就绪: ${task.domain} ${data.mode}`, '');

  try {
    // Step 1: Determine platform type and execute form filling
    const result = await chrome.tabs.sendMessage(tab.id, {
      action: 'executeSubmit',
      config: state.config,
      platformType: task.platformType,
      taskIndex: task.index,
    });

    if (result && result.error) {
      task.status = 'skip';
      task.skipReason = result.error;
      log(`${task.domain}: 跳过 - ${result.error}`, 'warn');
    } else if (result && result.captcha) {
      task.status = 'captcha';
      log(`${task.domain}: 验证码等待中`, 'warn');
      // Don't remove from activeTabs - wait for captcha resolution
      return;
    } else if (result && result.ok) {
      task.status = 'ok';
      task.isDofollow = result.isDofollow;
      task.relResult = result.rel;
      const relTag = result.isDofollow ? 'Dofollow ✅' : 'Nofollow';
      log(`${task.domain}: 提交成功 ${relTag}`, 'ok');

      // Ping index if enabled
      if (state.config.pingIndex) {
        pingIndexNow(task.url);
      }
    } else {
      task.status = 'skip';
      task.skipReason = 'unknown';
      log(`${task.domain}: 跳过（无匹配表单）`, 'warn');
    }
  } catch (err) {
    log(`${task.domain}: 错误 - ${err.message}`, 'err');
    task.status = 'err';
  }

  broadcastTaskUpdate(task);
  closeTab(tab.id);
}

function handleTimeout(tabId) {
  const taskIndex = state.activeTabs.get(tabId);
  if (!taskIndex) return;
  const task = state.tasks.find(t => t.index === taskIndex);
  if (task) {
    task.status = 'skip';
    task.skipReason = 'timeout';
    log(`${task.domain}: 超时跳过`, 'warn');
    broadcastTaskUpdate(task);
  }
  closeTab(tabId);
}

async function resumeAfterCaptcha(tabId, data) {
  const taskIndex = state.activeTabs.get(tabId);
  if (!taskIndex) return;
  const task = state.tasks.find(t => t.index === taskIndex);
  if (!task) return;

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'finalizeSubmit',
      config: state.config,
      taskIndex: task.index,
    });
    if (result && result.ok) {
      task.status = 'ok';
      task.isDofollow = result.isDofollow;
      task.relResult = result.rel;
      log(`${task.domain}: 提交成功 ${result.isDofollow ? 'Dofollow' : 'Nofollow'}`, 'ok');
    } else {
      task.status = 'err';
    }
  } catch (err) {
    task.status = 'err';
  }
  broadcastTaskUpdate(task);
  closeTab(tabId);
}

// ─── Tab Management ───
function closeTab(tabId) {
  state.activeTabs.delete(tabId);
  chrome.tabs.remove(tabId).catch(() => {});
}

function closeAllTabs() {
  for (const [tabId] of state.activeTabs) {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  state.activeTabs.clear();
}

chrome.tabs.onRemoved.addListener(tabId => {
  const taskIndex = state.activeTabs.get(tabId);
  if (taskIndex) {
    const task = state.tasks.find(t => t.index === taskIndex);
    if (task && task.status === 'running') {
      task.status = 'skip';
      broadcastTaskUpdate(task);
    }
    state.activeTabs.delete(tabId);
  }
});

// ─── Messaging ───
function broadcastTaskUpdate(task) {
  chrome.runtime.sendMessage({
    action: 'taskUpdate',
    index: task.index,
    status: task.status,
    isDofollow: task.isDofollow,
    rel: task.relResult,
  }).catch(() => {}); // popup may not be open
}

function broadcastStatus() {
  chrome.runtime.sendMessage({
    action: 'status',
    running: state.running,
  }).catch(() => {});
}

function log(msg, cls) {
  chrome.runtime.sendMessage({ action: 'log', msg, cls }).catch(() => {});
}

// ─── IndexNow Ping ───
async function pingIndexNow(url) {
  try {
    await fetch('https://www.bing.com/indexnow?url=' + encodeURIComponent(url) + '&key=ea4b5c1e2f3a4b5c6d7e8f9a0b1c2d3e', {
      mode: 'no-cors'
    });
  } catch(e) { /* ignore */ }
}

// ─── Helpers ───
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }