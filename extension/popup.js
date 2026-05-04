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

// ─── Load URL Library ───
$('btnLoadLibrary').addEventListener('click', () => {
  urlList.value = URL_LIBRARY.join('\n');
  saveStorage({ urlList: urlList.value });
  log(`已加载 ${URL_LIBRARY.length} 个外链库 URL`, 'ok');
});

// ─── Logging ───
function log(msg, cls) {
  const time = new Date().toLocaleTimeString();
  logLines.push({ time, msg: formatAgentLog(msg), cls: cls || '' });
  if (logLines.length > 200) logLines.shift();
  renderLog();
}

function formatAgentLog(msg) {
  const text = String(msg || '');
  if (/DeepSeek local agent unavailable|local agent unavailable|127\.0\.0\.1:8787|ECONNREFUSED/i.test(text)) {
    return `${text} - 本地代理未运行：请在仓库根目录执行 python3 -m local_agent.server`;
  }
  if (/需要人工处理|needs_manual/i.test(text)) {
    return `${text} - needs_manual: 请手动处理验证码、登录或页面确认`;
  }
  if (/提交成功|judge success|success evidence|\/judge/i.test(text)) {
    return `${text} - /judge 已看到成功证据`;
  }
  return text;
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
  const map = {
    pending:'⏳等',
    running:'▶中',
    ok:'✅证',
    skip:'⏭跳',
    err:'❌错',
    captcha:'🤖人工',
    needs_manual:'🤖人工',
    blocked:'⛔停',
    unavailable:'⚠️代理'
  };
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

// ─── URL Library (from data_startup_directories.md) ───
const URL_LIBRARY = [
'http://aitoolslink.com/',
'http://betalist.com/',
'http://getapp.com/',
'http://nextbigwhat.com/',
'http://www.allstartups.info/',
'http://www.appvita.com/',
'http://www.place123.net/',
'http://www.travelful.net/',
'https://10words.io/',
'https://addyp.com/',
'https://akama.com/',
'https://allhrsoftware.com/',
'https://appadvice.com/',
'https://appagg.com/',
'https://apprater.net/',
'https://appsandwebsites.com/',
'https://appstimes.in/',
'https://appsumo.com/',
'https://awesomeindie.com/',
'https://awesomemarketingwebsites.com/',
'https://betafy.co/',
'https://bharathlisting.com/',
'https://brandfetch.com/',
'https://bsky.app/',
'https://buildinpublic.page/',
'https://business.trustpilot.com/',
'https://businesstoolvault.com/',
'https://changelog.com/',
'https://citypages.pro/',
'https://clutch.co/',
'https://coindrop.to/',
'https://companylistingnyc.com/',
'https://crazyaboutstartups.com/',
'https://crozdesk.com/',
'https://dang.ai/',
'https://dev.to/',
'https://devhunt.org/',
'https://devpost.com/',
'https://devresourc.es/',
'https://digitalmarketingdeal.com/',
'https://e27.co/',
'https://ebusinesspages.com/',
'https://ecommerce-stack.com/',
'https://enests.co/',
'https://enrollbusiness.com/',
'https://getmakerlog.com/',
'https://getworm.com/',
'https://gifyu.com/',
'https://gitlab.com/',
'https://gumroad.com/',
'https://hackernoon.com/',
'https://hackerspad.net/',
'https://handpickedtools.com/',
'https://hubpages.com/',
'https://indiemaker.space/',
'https://inventlist.com/',
'https://issuu.com/',
'https://ko-fi.com/',
'https://land-book.com/',
'https://launched.io/',
'https://lettergrowth.com/',
'https://list.ly/',
'https://make.rs/',
'https://nocodelist.co/',
'https://once.tools/',
'https://onepagelove.com/',
'https://partneroptimizer.com/',
'https://porch.com/',
'https://postmake.io/',
'https://primeindies.com/',
'https://resource.fyi/',
'https://saassurf.com/',
'https://sidebar.io/',
'https://softwaresupp.com/',
'https://solo.to/',
'https://sourceforge.net/',
'https://startupbuffer.com/',
'https://startupdope.com/',
'https://startupmatcher.com/',
'https://startupresources.io/',
'https://startuproulette.com/',
'https://startups.watch/',
'https://startupstage.app/',
'https://startuptile.com/',
'https://startuptracker.io/',
'https://startupxplore.com/',
'https://steemit.com/',
'https://techbehemoths.com/',
'https://the-dots.com/',
'https://theorg.com/',
'https://toolfinder.co/',
'https://tools.robingood.com/',
'https://trendystartups.com/',
'https://twelve.tools/',
'https://under1000mrr.tools/',
'https://uniquethis.com/',
'https://wellfound.com/',
'https://wip.co/',
'https://www.addonbiz.com/',
'https://www.affordhunt.com/',
'https://www.appvizer.com/',
'https://www.awwwards.com/',
'https://www.b2bco.com/',
'https://www.bizbangboom.com/',
'https://www.biztobiz.org/',
'https://www.bubblelife.com/',
'https://www.bufferapps.com/',
'https://www.business-software.com/',
'https://www.buymeacoffee.com/',
'https://www.cabinetm.com/',
'https://www.callupcontact.com/',
'https://www.chamberofcommerce.com/',
'https://www.citymapia.com/',
'https://www.crunchbase.com/',
'https://www.csslight.com/',
'https://www.curated.design/',
'https://www.cuspera.com/',
'https://www.devpages.io/',
'https://www.f6s.com/',
'https://www.featuredcustomers.com/',
'https://www.findcool.tools/',
'https://www.flickr.com/',
'https://www.freelistingindia.in/',
'https://www.freelistingusa.com/',
'https://www.g2.com/',
'https://www.gartner.com/',
'https://www.getbyte.tech/',
'https://www.getlisteduae.com/',
'https://www.goodreads.com/',
'https://www.google.com/business/',
'https://www.gptshunter.com/',
'https://www.hotfrog.com/',
'https://www.ilib.com/',
'https://www.indiehackers.com/',
'https://www.indielogs.com/',
'https://www.internetisbeautiful.com/',
'https://www.joinly.xyz/',
'https://www.locable.com/',
'https://www.localmote.com/',
'https://www.manta.com/',
'https://www.merchantcircle.com/',
'https://www.microstartups.co/',
'https://www.myopportunity.com/',
'https://www.nocodedevs.com/',
'https://www.patreon.com/',
'https://www.peerspot.com/',
'https://www.pinterest.com/',
'https://www.producthunt.com/',
'https://www.saasgenius.com/',
'https://www.saashub.com/',
'https://www.saasprojects.com/',
'https://www.saastr.com/',
'https://www.saasworthy.com/',
'https://www.selecthub.com/',
'https://www.serchen.com/',
'https://www.sideprojectors.com/',
'https://www.slant.co/',
'https://www.slideshare.net/',
'https://www.smartmoneymatch.com/',
'https://www.snapmunk.com/',
'https://www.softwareadvice.com/',
'https://www.softwareworld.co/',
'https://www.sortlist.com/',
'https://www.spaceleads.pro/',
'https://www.springwise.com/',
'https://www.startupguys.net/',
'https://www.startupinspire.com/',
'https://www.startups-list.com/',
'https://www.startus.cc/',
'https://www.superpages.com.au/',
'https://www.techpluto.com/',
'https://www.toolspedia.io/',
'https://www.toools.design/',
'https://www.trustradius.com/',
'https://www.uneed.best/',
'https://www.webdesignernews.com/',
'https://www.webwiki.com/',
'https://www.wewaat.com/',
'https://www.whatsyourhours.com/',
'https://www.whodoyou.com/',
'https://www.workspaces.xyz/',
'https://www.zipleaf.us/',
'https://yellow.place/',
'https://yourstory.com/companies',
'https://zumvu.com/',
];

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
