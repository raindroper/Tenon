const api = window.raeDevice;
const element = id => document.getElementById(id);
let state; let busy = false;
let wechatAction = ''; let wechatGeneration = 0; let wechatSettings; let wechatRevision = 0;
let wechatCandidates; let wechatAutoDraft;
const wechatSelected = new Set();
const wechatCandidateInputs = new Map();
const wechatDetails = new Map();
let wechatHistoryEntry;
const wechatSearch = element('wechat-search');
const wechatTopic = element('wechat-topic');
const wechatAutoStart = element('wechat-auto-start');
const wechatPhases = { idle: '未观察', starting: '正在开始', watching: '正在观察', reconnecting: '正在重连', stopping: '正在停止', paused: '已暂停' };

function wechatOptions(select, options, placeholder) {
  const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = placeholder;
  const choices = options.map(({ id, title }) => {
    const option = document.createElement('option'); option.value = id; option.textContent = title; return option;
  });
  select.replaceChildren(prompt, ...choices);
  select.value = '';
}
function wechatStatus(message = '', error = false) {
  const status = element('wechat-status');
  status.textContent = message; status.hidden = !message; status.toggleAttribute('data-error', error);
}
function clearWechatDiscovery() {
  wechatGeneration++;
  wechatSelected.clear(); wechatCandidates = undefined; wechatSearch.value = '';
  wechatOptions(wechatTopic, [], '尚未读取');
  renderWechatCandidates();
}
function resetWechat() {
  clearWechatDiscovery(); wechatAutoDraft = undefined; wechatDetails.clear();
  wechatStatus();
  renderWechat();
}
function renderWechatCandidates() {
  const list = element('wechat-windows');
  wechatCandidateInputs.clear();
  const normalize = value => value.normalize('NFKC').toLocaleLowerCase();
  const words = normalize(wechatSearch.value).trim().split(/\s+/).filter(Boolean);
  const matches = (wechatCandidates || []).filter(({ title }) => words.every(word => normalize(title).includes(word)));
  const rows = matches.map(({ id, title, ambiguous, saved, chatType, disambiguation }) => {
    const row = document.createElement('label'); row.className = 'wechat-checkbox';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = wechatSelected.has(id);
    const name = document.createElement('span'); name.textContent = `${title} · ${chatType === 'group' ? '群聊' : '私聊'}`;
    if (ambiguous || saved) {
      const cue = document.createElement('small');
      cue.textContent = saved ? '已保存。' : `同名会话 · ${disambiguation || '请在微信中核对后选择'}`;
      name.append(cue);
    }
    input.addEventListener('change', () => {
      if (input.disabled) return;
      if (input.checked) wechatSelected.add(id); else wechatSelected.delete(id);
      renderWechat();
    });
    wechatCandidateInputs.set(id, { input, unavailable: Boolean(saved) });
    row.append(input, name); return row;
  });
  list.replaceChildren(...rows); list.hidden = !rows.length;
  const hint = wechatCandidates === undefined ? '' :
    !wechatCandidates.length ? '未找到会话。请登录电脑版微信并同步聊天记录后重试。' :
      !matches.length ? `无匹配会话。清空搜索可查看全部 ${wechatCandidates.length} 个。` : `找到 ${matches.length} 个会话。`;
  const hintElement = element('wechat-window-hint');
  hintElement.hidden = !hint;
  if (hintElement.textContent !== hint) hintElement.textContent = hint;
}
function renderWechatSettings(value) {
  wechatSettings = value; wechatRevision++;
  if (wechatAutoDraft === value.autoStart) wechatAutoDraft = undefined;
  const entries = element('wechat-entries');
  const expanded = new Set([...entries.querySelectorAll('details[open]')].map(item => item.closest('.wechat-entry').dataset.id));
  entries.replaceChildren(...value.entries.map(entry => {
    const row = document.createElement('div'); row.className = 'wechat-entry';
    row.dataset.id = entry.id;
    const content = document.createElement('div');
    const heading = document.createElement('div'); heading.className = 'wechat-entry-title';
    const title = document.createElement('strong'); title.textContent = entry.title;
    const badge = document.createElement('span'); badge.className = 'badge';
    badge.dataset.phase = entry.phase; badge.textContent = wechatPhases[entry.phase] || '未观察';
    const topic = document.createElement('p'); topic.textContent = `场景 · ${entry.topicTitle}`;
    heading.append(title, badge); content.append(heading, topic);
    if (entry.message && entry.phase !== 'watching') {
      const message = document.createElement('p'); message.textContent = entry.message; content.append(message);
    }
    const stats = document.createElement('p');
    stats.textContent = entry.receivedRows === undefined ? '本机进度未知，可查看接收详情。' :
      `已上传 ${entry.receivedRows} 条 · 待上传 ${entry.pendingRows ?? 0} 条${entry.lastReceivedAt ? ` · 最近上传 ${wechatTime(entry.lastReceivedAt)}` : ''}`;
    if (entry.coverageStartAt) stats.textContent += ` · 起点 ${wechatTime(entry.coverageStartAt)}`;
    content.append(stats);
    if (entry.coverageNote) { const note = document.createElement('p'); note.className = 'unavailable'; note.textContent = entry.coverageNote; content.append(note); }
    const controls = document.createElement('div'); controls.className = 'wechat-entry-actions';
    const actionButton = (label, action) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
      button.addEventListener('click', () => wechatEntryAction(entry.id, action)); controls.append(button);
    };
    if (entry.paused || ['paused', 'idle'].includes(entry.phase)) {
      actionButton('补采并恢复', 'resume'); actionButton('从现在恢复', 'restart-now');
    } else { actionButton('暂停', 'pause'); actionButton('同步一次', 'sync'); }
    actionButton('接收与分析详情', 'status'); actionButton('立即分析', 'analyze');
    const history = document.createElement('button'); history.type = 'button'; history.className = 'secondary'; history.textContent = '补采历史';
    history.addEventListener('click', () => {
      wechatHistoryEntry = entry.id; element('wechat-history-title').textContent = `补采历史 · ${entry.title}`;
      element('wechat-replay-since').value = ''; element('wechat-replay-until').value = '';
      element('wechat-history-dialog').showModal();
    });
    controls.append(history);
    const cadence = document.createElement('select'); cadence.setAttribute('aria-label', `${entry.title} 分析间隔`);
    for (const minutes of [1, 10, 30, 60]) {
      const option = document.createElement('option'); option.value = String(minutes); option.textContent = `每 ${minutes} 分钟分析`; cadence.append(option);
    }
    cadence.value = String(entry.analysisIntervalMinutes || 10);
    cadence.addEventListener('change', () => wechatEntryAction(entry.id, 'interval', Number(cadence.value)));
    controls.append(cadence); content.append(controls);
    const detail = wechatDetails.get(entry.id);
    if (detail) {
      const summary = document.createElement('p');
      const analysis = detail.analysis;
      summary.textContent = `服务端已收 ${detail.totalMessages ?? detail.totalRows} 条消息 · 已分析 ${analysis.analyzedCount} 条记录 · 待分析 ${analysis.pendingCount} 条 · 分析中 ${analysis.processingCount} 条 · 失败 ${analysis.failedCount} 条。最近分析 ${wechatTime(analysis.lastAnalyzedAt)}。长消息按片段处理。`;
      const received = document.createElement('p'); received.textContent = `服务端最近接收 ${wechatTime(detail.lastReceivedAt)} · 记录起点 ${wechatTime(detail.coverageStartAt)}。`;
      content.append(summary, received);
      const preview = document.createElement('details'); preview.open = expanded.has(entry.id);
      const previewTitle = document.createElement('summary'); previewTitle.textContent = '最近收到的原文'; preview.append(previewTitle);
      for (const item of detail.recent) {
        const text = document.createElement('p'); text.className = 'wechat-preview';
        text.textContent = `${item.isSelf ? '我' : item.senderName || '发送人未知'} · ${wechatTime(item.sentAt)}\n${item.content}`; preview.append(text);
      }
      if (!detail.recent.length) { const empty = document.createElement('p'); empty.textContent = '暂无已接收消息。'; preview.append(empty); }
      content.append(preview);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary';
    remove.textContent = '移除'; remove.setAttribute('aria-label', `移除 ${entry.title}`);
    remove.addEventListener('click', () => performWechat('remove', '正在移除会话…', () => api.wechatRemove(entry.id)));
    row.append(content, remove); return row;
  }));
  renderWechat();
}
function wechatTime(value) { return value ? new Date(value).toLocaleString() : '暂无'; }
function wechatEntryAction(id, action, interval) {
  void performWechat(action, action === 'analyze' ? '正在请求分析已收到的新消息…' : '正在更新会话状态…', async () => {
    const result = await api.wechatAction(id, action, interval);
    if (result.detail) wechatDetails.set(id, result.detail);
    renderWechatSettings(result.settings);
    wechatStatus(action === 'analyze' ? '已请求分析。推理暂停时，请在榫中恢复推理。' : action === 'restart-now' ? '已从现在重新建立采集起点。' : '会话状态已更新。');
  });
}
function renderWechat() {
  const settingsUnavailable = !state || state.closing || Boolean(wechatAction) || !wechatSettings;
  const discoveryUnavailable = settingsUnavailable || busy || !state.paired;
  const entries = wechatSettings?.entries || [];
  const limit = wechatSettings?.limit || 0;
  const remaining = Math.max(0, limit - entries.length);
  const watching = entries.filter(entry => entry.phase === 'watching').length;
  const badge = element('wechat-phase');
  badge.textContent = !wechatSettings ? '正在读取状态…' : watching ? `${watching} 个会话观察中` : wechatSettings.autoStart ? '自动观察已开启' : '自动观察已关闭';
  badge.dataset.phase = watching ? 'watching' : '';
  element('wechat-startup').hidden = !wechatSettings;
  element('wechat-saved').hidden = !wechatSettings;
  element('wechat-picker').hidden = !wechatSettings;
  element('wechat-no-entries').hidden = entries.length > 0;
  element('wechat-saved-count').textContent = `${entries.length} / ${limit}`;
  const notice = element('wechat-observation-status');
  notice.hidden = !state || state.paired || !wechatSettings;
  notice.textContent = notice.hidden ? '' : '请先在桌面客户端登录并连接榫，再添加会话。';
  wechatAutoStart.disabled = settingsUnavailable;
  wechatAutoStart.checked = wechatAutoDraft ?? Boolean(wechatSettings?.autoStart);
  element('wechat-save-startup').disabled = settingsUnavailable || wechatAutoDraft === undefined;
  for (const button of element('wechat-entries').querySelectorAll('button')) button.disabled = settingsUnavailable;
  for (const select of element('wechat-entries').querySelectorAll('select')) select.disabled = settingsUnavailable;
  for (const id of ['wechat-history', 'wechat-history-since', 'wechat-history-until', 'wechat-interval']) element(id).disabled = discoveryUnavailable;
  element('wechat-server').textContent = state?.baseUrl || '配对时指定的服务';
  wechatSearch.disabled = discoveryUnavailable;
  element('wechat-find').disabled = discoveryUnavailable;
  for (const [id, { input, unavailable }] of wechatCandidateInputs) {
    input.disabled = discoveryUnavailable || unavailable || !wechatSelected.has(id) && wechatSelected.size >= remaining;
  }
  element('wechat-topics').disabled = discoveryUnavailable;
  wechatTopic.disabled = discoveryUnavailable || wechatTopic.options.length < 2;
  element('wechat-add').disabled = discoveryUnavailable || !wechatSelected.size || wechatSelected.size > remaining || !wechatTopic.value;
  element('wechat-selected').textContent = `已选 ${wechatSelected.size} 个 · 还可保存 ${remaining} 个`;
}
async function performWechat(action, message, work) {
  const needsDevice = action === 'find' || action === 'topics' || action === 'add';
  if (!state || state.closing || wechatAction || !wechatSettings || needsDevice && (busy || !state.paired)) return;
  const generation = wechatGeneration;
  const revision = wechatRevision;
  const current = () => generation === wechatGeneration && !state?.closing;
  wechatAction = action; wechatStatus(message); render(state);
  try {
    const value = await work(current);
    if (value && !state?.closing) {
      const present = current();
      if (revision === wechatRevision) renderWechatSettings(value);
      if (action === 'add' || action === 'remove') clearWechatDiscovery();
      if (action === 'startup') wechatAutoDraft = undefined;
      if (present) {
        wechatStatus(action === 'add' ? '已保存所选会话。' : action === 'remove' ? '已移除该会话。' : '已保存启动设置。');
      }
    }
  }
  catch (error) {
    if (current()) {
      if (action === 'topics') wechatOptions(wechatTopic, [], '请重新读取场景');
      wechatStatus(String(error?.message || error || '微信观察操作未完成。')
        .replace(/^Error invoking remote method '[^']+': Error: /, '').slice(0, 400), true);
    }
  } finally { wechatAction = ''; if (state) render(state); }
}
function render(value) {
  if (!value.baseUrl) element('pairing-settings').open = true;
  if (state && (state.baseUrl !== value.baseUrl || state.paired && !value.paired || !state.closing && value.closing)) resetWechat();
  state = value; element('status').textContent = value.status; element('paired').textContent = value.paired ? '已登记' : '未连接';
  const actionsDisabled = busy || Boolean(wechatAction) || value.closing;
  if (document.activeElement !== element('base-url')) element('base-url').value = value.baseUrl;
  if (document.activeElement !== element('device-name')) element('device-name').value = value.name;
  element('execution-state').textContent = value.draining ? '正在等待原生操作结束…' : value.paused ? '本地执行已暂停' : '只接受获准范围内的任务';
  element('toggle').textContent = value.paused ? '恢复本地执行' : '暂停本地执行'; element('toggle').disabled = actionsDisabled || value.draining || !value.paired;
  element('reconnect').hidden = value.online || (value.paired && value.paused);
  element('reconnect').disabled = actionsDisabled || value.draining;
  element('pair-form').querySelector('button[type=submit]').disabled = actionsDisabled;
  element('chat').disabled = actionsDisabled;
  const update = value.update;
  const updateBusy = ['checking', 'downloading', 'installing'].includes(update.phase);
  element('update-version').textContent = `当前版本 ${update.currentVersion}`;
  element('update-status').textContent = update.message;
  element('check-update').disabled = actionsDisabled || updateBusy || !update.enabled;
  element('install-update').hidden = !update.availableVersion;
  element('install-update').disabled = actionsDisabled || updateBusy || value.draining;
  element('install-update').textContent = update.availableVersion ? `下载并安装 ${update.availableVersion}` : '下载并安装';
  element('previous-grants').hidden = value.grants.length === 0;
  element('grants').replaceChildren();
  for (const grant of value.grants) {
    const row = document.createElement('div'); row.className = 'grant'; const content = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = grant.root;
    const program = document.createElement('p'); program.textContent = `程序：${grant.executable}`;
    const mode = document.createElement('p'); mode.textContent = `${grant.readOnly ? '目录只读' : '目录可读写'} · 授权版本 ${grant.revision} · ${grant.available ? '严格隔离可用' : grant.reason || '等待能力检查'}`; if (!grant.available) mode.className = 'unavailable';
    content.append(title, program, mode); const remove = document.createElement('button'); remove.className = 'quiet'; remove.textContent = '撤回'; remove.disabled = actionsDisabled || value.draining;
    remove.addEventListener('click', () => perform(() => api.revokeGrant(grant.id))); row.append(content, remove); element('grants').append(row);
  }
  renderWechat();
}
async function perform(work) {
  if (busy || wechatAction) return; busy = true; element('error').textContent = ''; for (const button of document.querySelectorAll('button')) button.disabled = true;
  renderWechat();
  try { const value = await work(); if (value) render(value); }
  catch (error) { element('error').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; if (state) render(state); }
}
element('wechat-find').addEventListener('click', () => performWechat('find', '正在读取本机微信会话列表…', async current => {
  wechatCandidates = undefined; wechatSelected.clear(); renderWechatCandidates();
  const windows = await api.wechatWindows();
  if (!current()) return;
  wechatCandidates = windows; renderWechatCandidates(); wechatStatus();
}));
wechatSearch.addEventListener('input', () => { renderWechatCandidates(); renderWechat(); });
element('wechat-topics').addEventListener('click', () => performWechat('topics', '正在读取可选场景…', async current => {
  wechatOptions(wechatTopic, [], '正在读取场景…');
  const topics = await api.wechatTopics();
  if (!current()) return;
  wechatOptions(wechatTopic, topics, topics.length ? '请选择场景' : '暂无可用场景');
  wechatStatus(topics.length ? '' : '请先在榫中创建一个可用场景。');
}));
wechatTopic.addEventListener('change', renderWechat);
element('wechat-add').addEventListener('click', () => {
  const windowIds = [...wechatSelected]; const caseId = wechatTopic.value;
  if (element('wechat-add').disabled || !windowIds.length || !caseId) return;
  void performWechat('add', '正在保存所选会话…', () => {
    const options = { analysisIntervalMinutes: Number(element('wechat-interval').value) };
    const history = element('wechat-history').value;
    if (history === 'day') options.historySince = new Date(Date.now() - 86400000).toISOString();
    if (history === 'custom') {
      const since = new Date(element('wechat-history-since').value);
      if (!Number.isFinite(since.getTime())) throw new Error('请选择历史开始时间。');
      options.historySince = since.toISOString();
      if (element('wechat-history-until').value) options.historyUntil = new Date(element('wechat-history-until').value).toISOString();
    }
    return api.wechatAdd(windowIds, caseId, options);
  });
});
element('wechat-history').addEventListener('change', () => { element('wechat-history-range').hidden = element('wechat-history').value !== 'custom'; });
element('wechat-history-cancel').addEventListener('click', () => element('wechat-history-dialog').close());
element('wechat-history-form').addEventListener('submit', event => {
  event.preventDefault();
  const since = new Date(element('wechat-replay-since').value);
  const until = element('wechat-replay-until').value ? new Date(element('wechat-replay-until').value) : undefined;
  if (!wechatHistoryEntry || !Number.isFinite(since.getTime()) || since.getTime() > Date.now() || until && (!Number.isFinite(until.getTime()) || until < since || until.getTime() > Date.now())) {
    element('wechat-replay-since').setCustomValidity('请选择不晚于现在且顺序正确的历史时段。');
    element('wechat-replay-since').reportValidity(); return;
  }
  element('wechat-replay-since').setCustomValidity('');
  element('wechat-history-dialog').close();
  wechatEntryAction(wechatHistoryEntry, 'history', { historySince: since.toISOString(), ...(until ? { historyUntil: until.toISOString() } : {}) });
});
element('wechat-replay-since').addEventListener('input', () => element('wechat-replay-since').setCustomValidity(''));
element('wechat-replay-until').addEventListener('input', () => element('wechat-replay-since').setCustomValidity(''));
wechatAutoStart.addEventListener('change', () => {
  const enabled = wechatAutoStart.checked;
  wechatAutoDraft = enabled === wechatSettings?.autoStart ? undefined : enabled;
  renderWechat();
});
element('wechat-save-startup').addEventListener('click', () => {
  const enabled = wechatAutoDraft;
  if (enabled === undefined) return;
  void performWechat('startup', '正在保存启动设置…', () => api.wechatSetAutoStart(enabled));
});
api.onWeChatReset(resetWechat);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetWechat(); });
api.onWeChatSettings(renderWechatSettings);
setInterval(async () => {
  if (document.hidden || !state || state.closing || wechatAction || busy) return;
  for (const id of wechatDetails.keys()) {
    if (!wechatSettings?.entries.some(entry => entry.id === id)) { wechatDetails.delete(id); continue; }
    if (document.hidden || wechatAction || busy) break;
    try {
      const result = await api.wechatAction(id, 'status');
      if (document.hidden) break;
      wechatDetails.set(id, result.detail); renderWechatSettings(result.settings);
    } catch { /* Leave the last confirmed snapshot visible; explicit refresh reports connection failures. */ }
  }
}, 30000);
const initialWechatRevision = wechatRevision;
void api.wechatSettings().then(value => { if (initialWechatRevision === wechatRevision) renderWechatSettings(value); })
  .catch(() => { if (initialWechatRevision === wechatRevision) wechatStatus('无法读取微信观察状态，请重新打开设备面板。', true); });
element('pair-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => { const value = await api.pair(element('base-url').value, element('pairing-token').value, element('device-name').value); element('pairing-token').value = ''; return value; }); });
element('toggle').addEventListener('click', () => perform(() => state.paused ? api.resume() : api.pause()));
element('reconnect').addEventListener('click', () => perform(() => api.reconnect()));
element('check-update').addEventListener('click', () => perform(() => api.checkUpdate()));
element('install-update').addEventListener('click', () => perform(() => api.installUpdate()));
element('chat').addEventListener('click', () => perform(() => api.openChat())); api.onState(render); void perform(() => api.state());
