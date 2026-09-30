(() => {
  'use strict';
  const section = document.createElement('section');
  section.id = 'executor-workbench';
  section.className = 'executor-workbench';
  section.innerHTML = `<h2>运行工作台</h2><p>选择产品和范围，由 Windows 执行器逐站处理。</p>
    <details id="executor-pair-details"><summary>运行设备 · 配对与连接</summary>
      <label>执行器地址<input id="executor-endpoint" value="http://127.0.0.1:19388" autocomplete="off"></label>
      <label>一次性配对码<input id="executor-code" type="password" autocomplete="off" placeholder="启动 executor/start.ps1 后查看 pairing.txt"></label>
      <button id="executor-pair" type="button">配对此设备</button></details>
    <div class="executor-controls"><label>产品<select id="executor-profile"></select></label>
      <label>本次上限<input id="executor-limit" type="number" min="1" max="500" value="50"></label></div>
    <details><summary>指定本次外链范围</summary><label>从外链库选定的网址，每行一个；留空使用完整库<textarea id="executor-urls" rows="3"></textarea></label></details>
    <div class="executor-controls"><button id="executor-preview" type="button">预览范围</button><button id="executor-start" type="button" disabled>开始</button>
      <button id="executor-pause" type="button">暂停</button><button id="executor-resume" type="button">继续</button>
      <button id="executor-refresh" type="button">刷新状态</button></div>
    <details><summary>维护与待办页整理</summary><button id="executor-sync" type="button">补传云端</button><button id="executor-archive-gates" type="button">登记并关闭登录/验证码页</button></details>
    <p id="executor-status" role="status" aria-live="polite">尚未连接执行器</p>
    <div id="executor-scope"></div><label>查看批次<select id="executor-run"></select></label><div id="executor-results"></div><pre id="executor-details" hidden></pre><img id="executor-evidence" hidden alt="该任务的浏览器证据" style="max-width:100%;height:auto"><details id="executor-diagnostic-section" hidden><summary>诊断详情</summary><pre id="executor-diagnostics"></pre></details>`;
  const anchor = document.querySelector('.page-head') || document.querySelector('.app-header');
  const host = document.getElementById('panel-workbench');
  if (host) host.append(section); else if (anchor) anchor.after(section); else document.body.prepend(section);
  const $ = id => document.getElementById(`executor-${id}`);
  let connection, preview, selectedRunId, lastStatus, busy = 0, polling = false, scopeVersion = 0;
  async function refreshProfiles() {
    const data = await request('/catalog');
    const selected = $('profile').value;
    $('profile').replaceChildren();
    for (const [id, profile] of Object.entries(data.profiles || {})) {
      const option = document.createElement('option'); option.value = id; option.textContent = profile.name || id; $('profile').append(option);
    }
    if (data.profiles?.[selected]) $('profile').value = selected;
    window.dispatchEvent(new CustomEvent('externallink:catalog', { detail: data }));
  }
  const labels = { pending: '待执行', opening: '打开中', filling: '填写中', submitting: '提交中', needs_manual: '待人工', submitted_unconfirmed: '待核验', finished: '执行结束', excluded: '已排除', not_submitted: '未提交', sent_unconfirmed: '已发送未确认', accepted: '站方已接收', pending_review: '未审阅', reviewed: '已审阅', disputed: '有异议', final_captcha:'最后验证码', human_verification:'等待验证码', login_required:'等待登录', form_filled:'资料已填', validated_form:'资料已校验', receipt_verification:'收件核验', not_filled:'尚未填写' };
  function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
  async function request(route, body) {
    const endpoint = new URL($('endpoint').value);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/') throw new Error('执行器地址必须为 http://127.0.0.1:端口');
    const response = await fetch(new URL(route, endpoint), { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', ...(connection?.localToken ? { Authorization: `Bearer ${connection.localToken}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `执行器 HTTP ${response.status}`);
    return data;
  }
  async function act(fn) {
    busy++;
    status('正在处理…');
    try { await fn(); } catch (error) { status(error.name === 'TimeoutError' ? '执行器响应超时，请刷新检查当前任务；不会重新提交。' : error.message === 'Failed to fetch' ? '无法连接本机执行器，请先运行 executor/start.ps1。' : error.message, true); }
    finally { busy--; }
  }
  function render(data) {
    lastStatus = data;
    window.dispatchEvent(new CustomEvent('externallink:tasks',{detail:data}));
    const runs = [...(data.runs || [])].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!runs.some(run => run.id === selectedRunId)) selectedRunId = runs[0]?.id;
    $('run').replaceChildren();
    for (const run of runs) { const option = document.createElement('option'); option.value=run.id; option.textContent=`${run.profileId} · ${run.tasks.length} 站 · 资料版本 ${run.profileRevision}`; $('run').append(option); }
    if (selectedRunId) $('run').value=selectedRunId;
    const tasks = (data.tasks || []).filter(task => !selectedRunId || task.runId===selectedRunId);
    $('pause').hidden = Boolean(data.paused);
    $('resume').hidden = !data.paused;
    $('sync').disabled = !(data.pendingEvents || data.workbenchPendingEvents);
    const priority={final_captcha:0,receipt_verification:1,validated_form:2,form_filled:3,human_verification:4,login_required:5,not_filled:6};
    tasks.sort((a,b)=>(priority[a.recoveryCheckpoint?.stage]??(a.attentionType==='human_verification'?3:a.attentionType==='login'?4:10))-
      (priority[b.recoveryCheckpoint?.stage]??(b.attentionType==='human_verification'?3:b.attentionType==='login'?4:10))||
      String(b.recoveryCheckpoint?.recordedAt||'').localeCompare(String(a.recoveryCheckpoint?.recordedAt||'')));
    status(`${data.paused ? '已暂停' : '运行中'}${data.offlineMode?.enabled ? ' · 离线继续，云端恢复后同步' : ''} · 本机待同步 ${data.pendingEvents} 条${data.workbenchPendingEvents ? ' · 工作台进度待同步 '+data.workbenchPendingEvents+' 条' : ''}${data.cloudError ? ` · ${data.cloudError}` : ''}`);
    const box = $('results'), expanded = box.querySelector('.executor-other-tasks')?.open || false; box.replaceChildren();
    const counts = document.createElement('p');
    counts.textContent = `总目标 ${tasks.length} · 站方接收 ${tasks.filter(t => t.siteStatus === 'accepted').length} · 待核验 ${tasks.filter(t => t.status === 'submitted_unconfirmed').length} · 待人工 ${tasks.filter(t => t.status === 'needs_manual').length} · 待执行 ${tasks.filter(t => t.status === 'pending').length}`;
    box.append(counts);
    const otherTasks = document.createElement('details'), otherSummary = document.createElement('summary');
    otherTasks.className = 'executor-other-tasks'; otherTasks.open = expanded; otherTasks.append(otherSummary);
    let otherCount = 0;
    for (const task of tasks) {
      const row = document.createElement('article'); row.className = 'executor-task';
      const title = document.createElement('strong'); title.textContent = `${task.profileId} · ${task.url}`;
      const state = document.createElement('p'); state.textContent = `${labels[task.status] || task.status} / ${labels[task.siteStatus] || task.siteStatus || '未提交'} / 站方审核：${task.receipt?.publicationStatus==='pending_moderation'?'待审核':'见外链总览'} / ${task.syncStatus==='pending' ? '本地待同步' : task.cloudVerified ? '收件记录已回填并回读' : task.syncStatus==='confirmed' ? '任务事件已云端回读' : '本地待同步'} / 我的审阅：${labels[task.reviewStatus] || task.reviewStatus || '未审阅'}`;
      const reason = document.createElement('p'); reason.textContent = task.reason || task.receipt?.evidence || '';
      row.append(title, state, reason);
      if(task.recoveryCheckpoint){
        const recovery=task.recoveryCheckpoint,checkpoint=document.createElement('p');
        checkpoint.textContent=`恢复进度：${labels[recovery.stage]||recovery.stage} · 已知字段 ${recovery.completedFieldCount||0} · ${recovery.formRecoverability==='unknown_requires_reentry'?'需重新填写':'已知资料可恢复但需复核'} · ${recovery.nextStep||''} · 关闭 ${recovery.closedAt||task.tabClosedAt||'时间未知'} · 原页 ${recovery.sourceTargetId||'未知'}`;
        row.append(checkpoint);
      }
      const actions=[['内容与证据','details',{}]];
      const canTakeover = window.ExtLinkWorkbench
        ? !data.offlineMode?.enabled && !task.attemptBoundary && !task.receipt && ['pending','needs_manual'].includes(task.status) && /^https?:\/\//.test(task.url)
        : Boolean(task.targetId) && !['finished','excluded'].includes(task.status);
      if (canTakeover && !task.workbenchHandoff) actions.push(['接管本站','takeover',window.ExtLinkWorkbench?{surface:'workbench'}:{}]);
      if (data.paused && task.attemptBoundary && !(task.receipt && task.cloudVerified)) actions.push(['核验回执','verify',{}]);
      const review = document.createElement('details'), reviewSummary = document.createElement('summary');
      reviewSummary.textContent = '登记审阅'; review.append(reviewSummary);
      actions.push(['已审阅','review',{reviewStatus:'reviewed'}],['有异议','review',{reviewStatus:'disputed'}]);
      if(task.recoveryCheckpoint&&(task.tabClosedAt||task.deferredRecovery?.targetUnavailableAt)&&!task.attemptBoundary&&task.status==='needs_manual')actions.unshift(['打开原任务','openRecoveryTask',{}]);
      for (const [label, action, extras] of actions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.onclick = () => act(async () => {
          if (action === 'details') {
            $('details').hidden = false; $('details').textContent = [
              `${task.profileId} · ${task.url}`, task.reason || '',
              `提交时间：${task.attemptBoundary || '尚未提交'}`, `站方证据：${task.receipt?.evidence || '尚无确认回执'}`,
              '\n实际填写内容', ...(task.actualSubmission?.fields?.map(field => `${field.label || field.name || '字段'}：${field.value}`) || ['尚未保存填写内容']),
              '\n实际附件', ...(task.actualSubmission?.attachments?.map(file => `${file.field}：${file.name}（${file.type}，${file.bytes} 字节）`) || ['无'])
            ].join('\n\n'); $('evidence').hidden=true;
            $('diagnostic-section').hidden=false; $('diagnostics').textContent=JSON.stringify(task,null,2);
            if (task.screenshot) { const evidence=await request('/evidence/'+encodeURIComponent(task.id)); $('evidence').src=evidence.dataUrl; $('evidence').hidden=false; }
            status('已显示该站实际内容与证据'); return;
          }
          const result = await request('/' + action, { taskId: task.id, ...extras }); render(result);
          if (result.takeover) { status(result.takeover.surface==='workbench'?'接管已保存并回读；打开本站后在外链总览登记实际结果。':'已打开本站页面，自动执行已暂停。'); $('diagnostic-section').hidden=false; $('diagnostics').textContent=JSON.stringify(result.takeover,null,2); }
        });
        if (action === 'review') { button.disabled = task.reviewStatus === extras.reviewStatus; review.append(button); }
        else row.append(button);
      }
      row.append(review);
      if(window.ExtLinkWorkbench&&task.workbenchHandoff){const open=document.createElement('a');open.textContent='打开本站并接手';open.href=task.workbenchHandoff.url;open.target='_blank';open.rel='noopener noreferrer';row.append(open);}
      if (['needs_manual','submitted_unconfirmed','opening','filling','submitting'].includes(task.status)) box.append(row);
      else { otherTasks.append(row); otherCount++; }
    }
    if (otherCount) { otherSummary.textContent = `其余任务与历史结果（${otherCount} 站）`; box.append(otherTasks); }
  }
  $('pair').onclick = () => act(async () => {
    let result = await request('/pair', { code: $('code').value.trim() });
    if (result.requiresCloud) {
      const device = await chrome.runtime.sendMessage({ action: 'executorProvisionDevice' });
      if (!device?.ok) throw new Error(device?.error || '请先连接原插件云端工作区');
      result = await request('/pair', { code: $('code').value.trim(), ...device });
    }
    connection = { endpoint: $('endpoint').value, localToken: result.localToken, deviceId: result.deviceId };
    await chrome.storage.local.set({ executorConnection: connection });
    $('code').value = ''; $('pair-details').open = false;
    await refreshProfiles(); render(await request('/status')); status('配对成功 · 已连接正式云端设备');
  });
  $('preview').onclick = () => act(async () => {
    const version = ++scopeVersion;
    preview = null; $('start').disabled = true;
    const data = await request('/preview', { profileId: $('profile').value, urls: $('urls').value.split(/\n/).map(x => x.trim()).filter(Boolean) });
    if (version !== scopeVersion) { status('范围已修改，请重新预览。'); return; }
    preview = data.preview;
    $('scope').textContent = `产品 ${preview.profileId} · 资料版本 ${preview.profileRevision} · 完整库 ${preview.total} 站 · 云端表格 ${preview.sources.cloudTableRows} 行 / 内置表格 ${preview.sources.bundledTableRows} 行 / URL 清单 ${preview.sources.cloudUrlListRows} 行 · 可执行 ${preview.tasks.length} · 排除 ${preview.exclusions.length}`;
    $('start').disabled = !preview.tasks.length; status('范围预览完成，开始后固定本次资料版本和免费投稿范围');
    $('details').hidden = false; $('details').textContent = [
      '本次使用的产品资料', ...Object.entries(preview.profile.fields || {}).map(([key,value]) => `${key}：${value}`),
      '\n本次选定站点', ...preview.tasks.slice(0, Number($('limit').value)).map(task=>task.url),
      '\n排除原因', ...preview.exclusions.map(item=>`${item.url}：${item.reason}`)
    ].join('\n\n');
    $('diagnostic-section').hidden=true; $('evidence').hidden=true;
  });
  $('run').onchange = () => { selectedRunId=$('run').value; if(lastStatus)render(lastStatus); };
  $('start').onclick = () => act(async () => { if (!preview) return; $('start').disabled = true; selectedRunId=null; render(await request('/start', { previewId: preview.id, limit: Number($('limit').value) })); });
  for (const action of ['pause','resume','sync','refresh']) $(''+action).onclick = () => act(async () => render(await request(action === 'refresh' ? '/status' : '/' + action, action === 'refresh' ? undefined : {})));
  $('archive-gates').onclick = () => act(async () => {const result=await request('/archiveDeferredTabs',{});render(result);status(`已关闭 ${result.cleanup?.closed?.length||0} 个登录/验证码待办页；恢复阶段与证据已登记。`);});
  function invalidatePreview() { scopeVersion++; preview = null; $('start').disabled = true; $('scope').textContent = ''; $('details').hidden = true; $('evidence').hidden = true; $('diagnostic-section').hidden = true; }
  for (const id of ['profile','urls','limit']) $(id).addEventListener('input', invalidatePreview);
  for (const id of ['profile','urls','limit']) $(id).addEventListener('change', invalidatePreview);
  window.addEventListener('externallink:select-range', event => {
    const {profileId, urls, label} = event.detail || {};
    if (!Array.isArray(urls) || !urls.length) return;
    const profile = [...$('profile').options].find(option => option.value === profileId);
    if (!profile) { status('当前产品尚未从执行器加载，请刷新后重试。', true); return; }
    $('profile').value = profileId;
    $('urls').value = [...new Set(urls)].join('\n');
    $('urls').closest('details').open = true;
    invalidatePreview();
    status(`已选择${label || '外链范围'} · ${urls.length} 站，请预览后开始。`);
  });
  setInterval(async () => {
    if (!connection || busy || polling || document.hidden) return;
    polling = true;
    try {
      const data = await request('/status');
      if (!busy && JSON.stringify(data) !== JSON.stringify(lastStatus)) render(data);
    } catch (error) { if (!busy) status('执行器连接中断，请检查设备；已有任务会保留。', true); }
    finally { polling = false; }
  }, 3000);
  chrome.storage.local.get(['executorConnection','siteProfiles','activeSiteId']).then(data => {
    connection = data.executorConnection;
    if (connection) $('endpoint').value = connection.endpoint; else $('pair-details').open = true;
    for (const [id, profile] of Object.entries(data.siteProfiles || {})) {
      const option = document.createElement('option'); option.value = id; option.textContent = profile.name || id; $('profile').append(option);
    }
    if (data.activeSiteId) $('profile').value = data.activeSiteId;
    if (connection) act(async () => {
      render(await request('/status'));
      await refreshProfiles().catch(error => status(`${$('status').textContent} · 云端资料暂不可用：${error.message}`, true));
    });
  });
})();
