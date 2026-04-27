// ExternalLink Extension - Popup UI & State Management
(function() {
'use strict';

// ─── Tab Switching ───
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('panel-' + t.dataset.panel).classList.add('active');
  });
});

// ─── DOM Refs ───
const $ = id => document.getElementById(id);
const btnStart = $('btnStart');
const btnStop = $('btnStop');
const urlList = $('urlList');
const taskList = $('taskList');
const logEl = $('log');
const targetDomain = $('targetDomain');
const brandName = $('brandName');
const anchorText = $('anchorText');
const cfgEmail = $('cfgEmail');
const cfgName = $('cfgName');

// ─── State ───
let tasks = [];
let running = false;
let stats = { done: 0, skip: 0, err: 0, total: 0, dofollow: 0, nofollow: 0 };
const logLines = [];

// ─── Load/Save ───
function loadStorage(keys, cb) {
  chrome.storage.local.get(keys, items => {
    if (chrome.runtime.lastError) return cb(null);
    cb(items);
  });
}

function saveStorage(obj) {
  chrome.storage.local.set(obj);
}

// Load persisted data
loadStorage([
  'targetDomain','brandName','anchorText','cfgEmail','cfgName','cfgAutoSkipCaptcha',
  'cfgConcurrency','cfgCommentTemplate','cfgPingIndex','urlList',
  'tasks','stats','running'
], items => {
  if (!items) return;
  if (items.targetDomain) targetDomain.value = items.targetDomain;
  if (items.brandName) brandName.value = items.brandName;
  if (items.anchorText) anchorText.value = items.anchorText;
  if (items.cfgEmail) cfgEmail.value = items.cfgEmail;
  if (items.cfgName) cfgName.value = items.cfgName;
  if (items.urlList) urlList.value = items.urlList;
  if (items.tasks) { tasks = items.tasks; renderTasks(); }
  if (items.stats) { stats = items.stats; updateStats(); }
  if (items.running) setRunning(true, false);
  $('cfgAutoSkipCaptcha').checked = !!items.cfgAutoSkipCaptcha;
  $('cfgConcurrency').value = items.cfgConcurrency || '3';
  $('cfgCommentTemplate').value = items.cfgCommentTemplate || '';
  $('cfgPingIndex').checked = items.cfgPingIndex !== false;
});

// Auto-save on change
[targetDomain, brandName, anchorText].forEach(el => {
  el.addEventListener('change', () => {
    saveStorage({
      targetDomain: targetDomain.value,
      brandName: brandName.value,
      anchorText: anchorText.value
    });
  });
});
urlList.addEventListener('change', () => saveStorage({ urlList: urlList.value }));

// ─── Config Save ───
$('btnSaveConfig').addEventListener('click', () => {
  saveStorage({
    cfgEmail: cfgEmail.value,
    cfgName: cfgName.value,
    cfgAutoSkipCaptcha: $('cfgAutoSkipCaptcha').checked,
    cfgConcurrency: $('cfgConcurrency').value,
    cfgCommentTemplate: $('cfgCommentTemplate').value,
    cfgPingIndex: $('cfgPingIndex').checked
  });
  alert('✅ 配置已保存');
});

$('btnClearData').addEventListener('click', () => {
  if (confirm('确认清除所有数据？包括已提交记录和日志')) {
    chrome.storage.local.clear();
    tasks = []; stats = {done:0,skip:0,err:0,total:0,dofollow:0,nofollow:0};
    logLines.length = 0;
    updateStats(); renderTasks(); renderLog();
    alert('已清除');
  }
});

$('btnClearLog').addEventListener('click', () => {
  logLines.length = 0;
  renderLog();
});

// ─── Logging ───
function log(msg, cls) {
  const time = new Date().toLocaleTimeString();
  logLines.push({ time, msg, cls: cls || '' });
  if (logLines.length > 200) logLines.shift();
  renderLog();
}

function renderLog() {
  logEl.innerHTML = logLines.map(l =>
    `<div class="log-line${l.cls ? ' ' + l.cls : ''}">[${l.time}] ${l.msg}</div>`
  ).join('');
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── Stats ───
function updateStats() {
  const remaining = Math.max(0, stats.total - stats.done - stats.skip - stats.err);
  $('statQueue').textContent = remaining;
  $('statDone').textContent = stats.done;
  $('statSkip').textContent = stats.skip;
  $('statErr').textContent = stats.err;
  const pct = stats.total > 0 ? ((stats.done + stats.skip + stats.err) / stats.total * 100) : 0;
  $('progressFill').style.width = pct + '%';
  saveStorage({ stats });
}

// ─── Tasks ───
function renderTasks() {
  const show = tasks.slice(-30);
  taskList.innerHTML = show.map((t, i) =>
    `<div class="task">
      <span class="idx">#${t.index}</span>
      <span class="domain">${t.domain}</span>
      <span class="status ${t.status}">${statusLabel(t.status)}</span>
    </div>`
  ).join('');
}

function statusLabel(s) {
  const map = {pending:'⏳等', running:'▶中', ok:'✅完', skip:'⏭跳', err:'❌错', captcha:'🤖码'};
  return map[s] || s;
}

// ─── Run Control ───
btnStart.addEventListener('click', async () => {
  const lines = urlList.value.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return alert('请粘贴外链列表');
  if (!targetDomain.value.trim()) return alert('请填写你的目标域名');

  if (running) return;
  stats = { done: 0, skip: 0, err: 0, total: lines.length, dofollow: 0, nofollow: 0 };
  tasks = lines.map((line, i) => {
    const parts = line.split('|').map(s => s.trim());
    return {
      index: i + 1,
      domain: extractDomain(parts[0]),
      url: parts[0],
      platformType: parts[1] || 'auto',
      status: 'pending'
    };
  });
  updateStats();
  renderTasks();
  log(`加载 ${tasks.length} 个外链目标`, 'ok');

  setRunning(true);
  await chrome.runtime.sendMessage({
    action: 'start',
    tasks: tasks,
    config: {
      targetDomain: targetDomain.value.trim(),
      brandName: brandName.value.trim() || 'My Tool',
      anchorText: anchorText.value.trim() || brandName.value.trim(),
      email: cfgEmail.value || generateEmail(),
      username: cfgName.value || generateName(),
      autoSkipCaptcha: $('cfgAutoSkipCaptcha').checked,
      concurrency: parseInt($('cfgConcurrency').value) || 3,
      commentTemplate: $('cfgCommentTemplate').value,
      pingIndex: $('cfgPingIndex').checked,
    }
  });
  log('任务已发送到后台', 'ok');
});

btnStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stop' });
  setRunning(false);
  log('已请求停止', 'warn');
});

function setRunning(r, save = true) {
  running = r;
  btnStart.style.display = r ? 'none' : 'block';
  btnStop.style.display = r ? 'block' : 'none';
  if (save) saveStorage({ running: r });
}

// ─── Background Messages ───
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === 'taskUpdate') {
    const t = tasks.find(x => x.index === msg.index);
    if (t) {
      t.status = msg.status;
      if (msg.status === 'ok') { stats.done++; if (msg.isDofollow) stats.dofollow++; else stats.nofollow++; }
      else if (msg.status === 'skip') stats.skip++;
      else if (msg.status === 'err') stats.err++;
      updateStats();
      renderTasks();
    }
  }
  if (msg.action === 'log') {
    log(msg.msg, msg.cls);
  }
  if (msg.action === 'status') {
    setRunning(msg.running);
  }
  if (msg.action === 'progress') {
    stats = msg.stats;
    updateStats();
  }
});

// ─── Helpers ───
function extractDomain(url) {
  try { return new URL(url.startsWith('http') ? url : 'https://'+url).hostname; } catch(e) { return url; }
}

function generateEmail() {
  const base = 'user' + Date.now().toString(36);
  return base + '@gmail.com';
}

function generateName() {
  const first = ['Alex','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery','Blake','Drew'];
  const last = ['Johnson','Williams','Brown','Davis','Wilson','Moore','Clark','Lewis','Walker','Allen'];
  return first[Math.floor(Math.random()*10)] + ' ' + last[Math.floor(Math.random()*10)];
}

// Init log
log('ExternalLink 外链提交扩展已就绪', 'ok');
log('用法：填域名 + 品牌名 → 粘贴外链列表 → 点击"开始提交"', '');

})();