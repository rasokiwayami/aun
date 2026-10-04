const $ = id => document.getElementById(id);
const purposes = ['self_reflection', 'conversation', 'draft_reply', 'compare', 'learn', 'create', 'plan'];
const purposeLabels = {self_reflection:'自分を振り返る',conversation:'会話',draft_reply:'返信を書く',compare:'比較する',learn:'学ぶ',create:'作る',plan:'計画する'};
const conditionFields = {recipient:'相手',relationship:'関係',activity:'活動',timeOfDay:'時間帯',channel:'連絡方法',project:'プロジェクト',location:'場所'};
let csrf = '', session = null, record = null, topic = 'start', pace = 'slow';
let active = false, paused = false, busy = false, revision = 0;
let voiceAbort = null, chatAbort = null, speakAbort = null, draftAbort = null, authPoll = null, settleTimer = null, idleTimer = null, draftTimer = null;
let failedCapture = null, pendingInterview = null, currentPack = null, editing = null, confirmCallback = null;
let speechChunks = new Map(), speechPrefix = '', draftSpeech = false, speechFinal = false, speechEdited = false;
let proposalOffset = 0, recoverMode = false, signingIn = false, pausedDraftSaved = false, selectedSource = null, documentRetry = null;
let currentSessionTaskId = crypto.randomUUID();
const stopWords = /^(?:ちょっと|少し)?(?:待って|まって|ストップ|一旦停止)[。！!\s]*$/;
const endWords = /^(?:今日はここまで|終わり|おわり|終了|やめる)[。！!\s]*$/;
const safeNode = (tag, text = '', cls) => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
const operation = () => crypto.randomUUID();
const unlocked = () => Boolean(record && session?.vault?.unlocked);
function status(text, thinking = false) { $('status').textContent = text; $('orb').classList.toggle('thinking', thinking); }
function error(text, area = 'error') { $(area).textContent = text; }
function show(id) { if (!$(id).open) $(id).showModal(); }
function actionButton(label, fn, cls = '') { const b = safeNode('button', label, cls); b.type = 'button'; b.onclick = fn; return b; }
function touch() { clearTimeout(idleTimer); if (unlocked()) { idleTimer = setTimeout(() => lockVault('しばらく操作がなかったため、ロックしました。'), 15 * 60 * 1000); idleTimer.unref?.(); } }
async function api(path, body, options = {}) {
  const res = await fetch(path, {method:body === undefined ? 'GET' : 'POST', headers:body === undefined ? {} : {'Content-Type':'application/json','X-CSRF-Token':csrf}, body:body === undefined ? undefined : JSON.stringify(body), signal:options.signal, cache:'no-store'});
  let data; try { data = await res.json(); } catch { throw Error('接続を確かめて、もう一度試してください。'); }
  if (!res.ok) {
    if (res.status === 401 && session?.vault?.unlocked) { clearPrivate(); session.vault.unlocked = false; controls(); openVault(); }
    throw Object.assign(Error(data.error === 'conflict_requires_resolution' ? '両立の確認が必要なメモがあります。「記録」から一方の内容や適用条件を編集するか、利用をやめてから、もう一度お試しください。' : data.message || '操作を完了できませんでした。'), {code:data.error});
  }
  return data;
}
function stopListening() { clearTimeout(settleTimer); settleTimer = null; voiceAbort?.abort(); voiceAbort = null; $('orb').style.setProperty('--level', '1'); }
function cancelWork() { revision++; stopListening(); draftAbort?.abort(); draftAbort = null; chatAbort?.abort(); chatAbort = null; speakAbort?.abort(); speakAbort = null; busy = false; }
async function stopAudio() { stopListening(); speakAbort?.abort(); speakAbort = null; try { await api('/api/stop-audio', {}); } catch {} }
function invalidatePack() { currentPack = null; $('packText').textContent = ''; $('packOmitted').textContent = ''; $('packResult').hidden = true; }
function applyRecord(next) { if (!next) return; record = next; selectedSource = null; topic = record.topic || topic; $('caption').textContent = ''; $('modelPreviewText').textContent = ''; invalidatePack(); drawRecord(); controls(); touch(); }
function controls() {
  const open = unlocked(), provider = session?.provider || {}, resting = record?.inquiry?.paused === true;
  for (const input of document.querySelectorAll('dialog input, dialog textarea, dialog select')) input.disabled = busy;
  $('clearDraft').disabled = busy || !open;
  $('unlockButton').hidden = open; $('historyButton').disabled = !open;
  $('start').hidden = !open || resting || active || !session?.capabilities?.voice;
  $('pause').hidden = !open || !active; $('finish').hidden = !open || resting; $('resumeSession').hidden = !open || !resting; $('resumeSession').disabled = busy;
  $('pauseDraftOffer').hidden = !open || !resting || !$('message').value.trim() || pausedDraftSaved;
  $('pause').textContent = paused ? '話を再開' : '少し待って';
  $('modeLinks').hidden = !open || resting; $('transcript').hidden = !open;
  for (const id of ['start','send','skip','refuse','applySettings','saveEdit','previewPack']) $(id).disabled = busy || !open;
  for (const id of ['send','skip','refuse']) $(id).disabled = busy || !open || resting;
  $('unlockedSettings').hidden = !open; $('lock').disabled = !open; $('backupButton').disabled = !open;
  $('connect').hidden = Boolean(provider.connected); $('connect').disabled = signingIn || !provider.available || !open;
  $('cancelAuth').hidden = !signingIn; $('disconnect').hidden = !provider.connected;
  $('accountInfo').textContent = provider.connected ? 'ChatGPTに接続済み · ChatGPTの利用枠を使用' : provider.available ? '未接続でも、記録・編集・書き出しができます。' : 'この環境ではChatGPT接続を利用できません。端末内の機能は使えます。';
  $('consentControls').hidden = !open;
  $('consentState').textContent = record?.consent?.model ? '会話と整理のための送信：オン' : '会話と整理のための送信：オフ';
  $('consentHint').hidden = !open;
  $('consentHint').replaceChildren();
  if (open && record.consent?.model) {
    $('consentHint').append(safeNode('span', provider.connected ? '記録後、この発言と利用を許可したメモをChatGPTへ送ります。' : 'ChatGPTは未接続です。今はこのMacだけに記録します。'));
    $('consentHint').append(actionButton('詳しく', () => show('consentDialog'), 'quiet'));
  } else if (open && provider.available) {
    $('consentHint').append(safeNode('span','今は端末内で記録します。回答に合わせて次の質問をしてもらうには、ChatGPTへの送信をオンにしてください。'));
    $('consentHint').append(actionButton(provider.connected ? '対話をオンにする' : 'ChatGPTに接続する', () => provider.connected ? show('consentDialog') : openSettings(), 'quiet'));
  } else if (open) {
    $('consentHint').append(safeNode('span','この環境では端末内に記録できます。次の質問は「別の問いへ」で選べます。'));
  }
}
function drawRecord() {
  if (!record) return;
  $('question').textContent = record.question || 'いま、話しておきたいことは？';
  $('topic').value = topic;
  $('topicLabel').textContent = session?.topicChoices?.find(t => t.id === topic)?.label || 'いま、話したいことから';
  $('transcriptBody').replaceChildren(); $('historyBody').replaceChildren();
  const messages = record.messages || [];
  for (const m of messages) {
    const line = safeNode('div', '', `line ${m.role === 'user' ? 'user' : ''}`);
    line.append(safeNode('div', m.role === 'user' ? (m.speaker === 'unknown' || m.speaker === 'other' ? '書き手未確認の記録' : 'あなた') : '聞き手', 'speaker'), safeNode('p', m.text));
    $('transcriptBody').append(line);
  }
  const sources = messages.filter(m => m.role === 'user' && m.kind !== 'navigation');
  if (!sources.length) $('historyBody').append(safeNode('p', 'まだ記録はありません。'));
  for (const m of sources) {
    const card = safeNode('div', '', 'card'); card.append(safeNode('p', m.text));
    const row = safeNode('div', '', 'small-actions');
    if (m.speaker !== 'unknown' && m.speaker !== 'other') row.append(actionButton('ChatGPTと続ける', () => prepareSourceInterview(m)));
    if (m.inputKind === 'document' || m.kind === 'document') card.append(safeNode('p', m.speaker === 'self' ? '自分が書いた文書' : '他の人・不明の文書', 'quiet'));
    row.append(actionButton('直す', () => openEditor('source', m)), actionButton('削除', () => confirmAction('発言を削除', 'この発言と、そこから作られた整理案・メモ・アプリ内の出力を削除します。外へ書き出したコピーは残ります。', () => mutate('/api/source/delete', {id:m.id,expectedRevision:m.revision}, 'confirmError')), 'danger'));
    card.append(row); $('historyBody').append(card);
  }
  $('storageState').textContent = sources.length ? 'このMacに保存済み' : '記録は暗号化して、このMacに保存';
  drawProposals(); drawKnowledge(); drawRefusals();
}
function assertionCard(a) {
  const card = safeNode('div', '', 'card'); card.append(safeNode('p', a.text));
  const scope = (a.scope?.purposes || []).map(p => purposeLabels[p] || p).join('、');
  if (scope) card.append(safeNode('p', `用途：${scope}`, 'quiet'));
  if ((record?.knowledge || []).some(other => other.id !== a.id && ['active','task_local'].includes(other.status) && ((a.conflictsWith || []).includes(other.id) || (other.conflictsWith || []).includes(a.id)))) card.append(safeNode('p', '未解決の両立確認あり。同じ用途・場面・時期で当てはまる間は出力を止めます。', 'quiet'));
  if (a.hardConstraint) card.append(safeNode('p', '必ず守る条件', 'quiet'));
  if (a.scope?.conditions?.length) card.append(safeNode('p', `条件：${a.scope.conditions.map(c => `${conditionFields[c.field] || c.field} ${({eq:'＝',neq:'≠',in:'いずれか',not_in:'いずれでもない'})[c.op]} ${Array.isArray(c.value) ? c.value.join('、') : c.value}`).join(' / ')}`, 'quiet'));
  if (a.scope?.exceptions?.length) card.append(safeNode('p', `例外（利用前に確認）：${a.scope.exceptions.join('、')}`, 'quiet'));
  if (a.validTime?.label) card.append(safeNode('p', `時期：${a.validTime.label}`, 'quiet'));
  if (a.validTime?.start || a.validTime?.end) card.append(safeNode('p', `期間：${a.validTime.start || '指定なし'} 〜 ${a.validTime.end || '指定なし'}`, 'quiet'));
  for (const e of a.evidence || []) if (e.quote) card.append(safeNode('blockquote', e.quote));
  if (a.explanation) card.append(safeNode('p', a.explanation, 'quiet'));
  return card;
}
function drawProposals() {
  const proposals = (record.proposals || []).filter(a => !a.status || ['proposed','held'].includes(a.status));
  if (proposalOffset >= proposals.length) proposalOffset = 0;
  $('proposalBody').replaceChildren();
  if (!proposals.length) $('proposalBody').append(safeNode('p', '確認を待つ整理案はありません。自分でメモを作ることもできます。'));
  for (const a of proposals.slice(proposalOffset, proposalOffset + 3)) {
    const card = assertionCard(a), row = safeNode('div', '', 'small-actions');
    card.append(safeNode('p', a.status === 'held' ? '保留中' : '未確認の整理案', 'quiet'));
    for (const [label, decision] of [['採用','accept'],['保留','hold'],['今回は使わない','reject'],['今回の会話だけ','task_only']]) row.append(actionButton(label, () => reviewAssertion({id:a.id,revision:a.revision}, decision)));
    card.append(row); $('proposalBody').append(card);
  }
  $('moreProposals').hidden = proposals.length <= 3;
}
function drawKnowledge() {
  $('knowledgeBody').replaceChildren();
  const knowledge = (record.knowledge || []).filter(a => !['invalidated','withdrawn'].includes(a.status));
  if (!knowledge.length) $('knowledgeBody').append(safeNode('p', '使えるメモはまだありません。'));
  for (const a of knowledge) {
    const card = assertionCard(a), row = safeNode('div', '', 'small-actions');
    card.append(safeNode('p', `${a.policy?.model ? 'AIで利用可' : 'AIでは利用しない'} · ${a.policy?.disclosure ? '他者向け利用可' : '自分のためだけ'}${a.status === 'task_local' ? ' · 今回の会話だけ（最大1時間）' : ''}`, 'quiet'));
    row.append(actionButton('編集', () => openEditor('knowledge', a)), actionButton('利用をやめる', () => mutate('/api/knowledge/withdraw', {id:a.id,expectedRevision:a.revision}, 'historyError')), actionButton('削除', () => confirmAction('メモを削除', '整理したメモだけを削除します。元の発言は残るため、必要なら「話したこと」から削除してください。関連する出力は無効になります。外へ書き出したコピーは残ります。', () => mutate('/api/knowledge/delete', {id:a.id,expectedRevision:a.revision}, 'confirmError')), 'danger'));
    card.append(row); $('knowledgeBody').append(card);
  }
}
function drawRefusals() {
  $('refusedTopics').replaceChildren();
  for (const t of record.inquiry?.refusedTopics || []) {
    const label = session?.topicChoices?.find(c => c.id === t)?.label || t;
    const row = safeNode('div', '', 'small-actions'); row.append(safeNode('span', `控えている話題：${label}`, 'quiet'), actionButton('再開する', () => navigate('resume', t))); $('refusedTopics').append(row);
  }
}
async function refresh() {
  const token = revision;
  const next = await api('/api/status'); if (token !== revision) return;
  session = next; csrf = next.csrf;
  if (next.topicChoices?.length) { $('topic').replaceChildren(); for (const t of next.topicChoices) { const o = safeNode('option', t.label); o.value = t.id; $('topic').append(o); } }
  if (next.vault?.unlocked) { const result = await api('/api/record'); if (token !== revision) return; applyRecord(result); $('composer').hidden = false; status(record.inquiry?.paused ? '質問の位置と保存済みの記録が残っています。続きから再開できます。' : '準備できました'); await restoreDraft(token); }
  else { clearPrivate(); controls(); openVault(); }
}
async function restoreDraft(token) {
  if (!record?.settings?.draftPersistence || $('message').value) return;
  try { const draft = await api('/api/draft'); if (token === revision && unlocked() && !$('message').value && typeof draft.text === 'string') { $('message').value = draft.text; pausedDraftSaved = true; controls(); } }
  catch { if (token === revision) error('保存した下書きを読み込めませんでした。記録は利用できます。'); }
}
function openVault() {
  recoverMode = false; $('passphrase').value = ''; $('recoveryInput').value = ''; error('', 'vaultError');
  const exists = Boolean(session?.vault?.exists);
  $('vaultTitle').textContent = exists ? '記録を開く' : '自分だけの記録を作る';
  $('vaultIntro').textContent = exists ? 'パスフレーズを入力してください。' : '10文字以上のパスフレーズで記録を暗号化します。ChatGPTへの接続は、あとから選べます。';
  $('vaultSubmit').textContent = exists ? '開く' : '作る'; $('recoveryOption').hidden = exists; $('recoverMode').hidden = !exists; $('recoveryInputLabel').hidden = true;
  $('passphrase').autocomplete = exists ? 'current-password' : 'new-password'; show('vaultDialog');
}
async function openWithPassphrase(e) {
  e.preventDefault(); if (busy) return;
  const passphrase = $('passphrase').value, recoveryCode = $('recoveryInput').value;
  if (passphrase.length < 10) { error('10文字以上で入力してください。', 'vaultError'); return; }
  const path = recoverMode ? '/api/vault/recover' : session.vault.exists ? '/api/vault/unlock' : '/api/vault/create';
  const token = revision;
  const body = recoverMode ? {recoveryCode,newPassphrase:passphrase} : {passphrase,...(!session.vault.exists ? {recovery:$('wantRecovery').checked} : {})};
  $('passphrase').value = ''; $('recoveryInput').value = ''; $('vaultSubmit').disabled = true; busy = true; controls();
  try {
    const result = await api(path, body); if (token !== revision) return; session.vault = {exists:true,unlocked:true}; currentSessionTaskId = operation(); applyRecord(result.record); $('vaultDialog').close(); $('composer').hidden = false; status(record.inquiry?.paused ? '質問の位置と保存済みの記録が残っています。続きから再開できます。' : '準備できました');
    if (result.recoveryCode) { $('recoveryCode').textContent = result.recoveryCode; show('recoveryDialog'); }
    await restoreDraft(token);
  } catch (e) { if (token === revision) error(e.message, 'vaultError'); } finally { $('vaultSubmit').disabled = false; if (token === revision) { busy = false; controls(); } }
}
function clearPrivate() {
  cancelWork(); clearTimeout(idleTimer); clearTimeout(draftTimer); clearInterval(authPoll); authPoll = null; signingIn = false;
  record = null; failedCapture = null; pendingInterview = null; editing = null; confirmCallback = null; selectedSource = null; documentRetry = null; pausedDraftSaved = false; speechChunks.clear(); speechPrefix = ''; draftSpeech = false; speechFinal = false; speechEdited = false; active = false; paused = false;
  invalidatePack();
  for (const id of ['message','editText','editExceptions','validStart','validEnd','validLabel','validPrecision','packQuery','backupPassphrase','backupFile','passphrase','recoveryInput','packPurpose','packAudience','packDestination','documentText','documentFile']) $(id).value = '';
  for (const id of ['caption','modelPreviewText','recoveryCode','confirmText','backupResult','conflictChoiceNote']) $(id).textContent = '';
  for (const id of ['transcriptBody','historyBody','proposalBody','knowledgeBody','refusedTopics','conditionRows','packConditionRows','legacyFiles','conflictChoices']) $(id).replaceChildren();
  for (const id of ['error','vaultError','settingsError','historyError','editorError','consentError','modelError','confirmError','packError','backupError','documentError']) error('', id);
  for (const id of ['settings','history','editor','consentDialog','modelPreview','packDialog','backupDialog','confirmDialog','recoveryDialog','documentDialog']) $(id).close();
  for (const id of ['autoSend','readAloud','policyModel','policyDisclosure','hardConstraint','acknowledgeHistory','toolQuestion','draftPersistence']) $(id).checked = false;
  for (const p of purposes) if ($(`scope_${p}`)) $(`scope_${p}`).checked = false;
  $('question').textContent = 'ひとつずつ、話してみよう。'; $('topicLabel').textContent = 'いま、話したいことから'; $('composer').hidden = true; $('draftHint').hidden = true; $('pauseDraftOffer').hidden = true; $('storageState').textContent = '記録をロックしています'; status('記録をロックしています');
}
async function lockVault(message) {
  clearPrivate(); if (session?.vault) session.vault.unlocked = false; controls();
  try { await api('/api/vault/lock', {}); await stopAudio(); if (message) status(message); }
  catch { error('画面は閉じました。保管庫のロックを確認できませんでした。もう一度ロックするか、アプリを終了してください。'); }
}
async function finish() {
  if (!unlocked()) return;
  cancelWork(); clearTimeout(draftTimer); active = false; paused = false; pendingInterview = null; invalidatePack(); busy = true; controls();
  const token = revision, controller = new AbortController(); chatAbort = controller; pausedDraftSaved = false;
  try {
    await stopAudio(); if (token !== revision) return;
    const text = $('message').value;
    if (text.trim() && record.settings?.draftPersistence && (!draftSpeech || speechFinal)) {
      try { await api('/api/draft',{text},{signal:controller.signal}); if (token !== revision) return; pausedDraftSaved = true; }
      catch (e) { if (token !== revision) return; error(`下書きは画面に残っています。${e.message}`); }
    }
    if (token !== revision) return;
    const result = await api('/api/navigate',{operationId:operation(),action:'pause'},{signal:controller.signal});
    if (token !== revision) return; applyRecord(result.record); $('caption').textContent = '';
    status('今日はここまで。質問の位置と、保存済みの回答・整理案・メモを残しました。'); showSpeechDraftHint(true);
  } catch (e) { if (token === revision && !controller.signal.aborted) { error(e.message); status('停止しました。中断位置の保存は確認できませんでした。'); } }
  finally { if (chatAbort === controller) { chatAbort = null; busy = false; controls(); } }
}
async function resumeSession() {
  if (await mutate('/api/navigate',{action:'resume'})) { $('composer').hidden = false; status('保存したところから、あなたのペースでどうぞ。'); controls(); }
}
async function savePausedDraft() {
  if (!unlocked() || busy || !$('message').value.trim()) return;
  if (!record.settings?.draftPersistence && !await mutate('/api/settings',{draftPersistence:true})) return;
  const token = revision;
  try { await api('/api/draft',{text:$('message').value}); if (token !== revision) return; pausedDraftSaved = true; status('下書きも暗号化して24時間保存しました。'); controls(); }
  catch (e) { if (token === revision) error(e.message); }
}
function showSpeechDraftHint(interrupted = false) {
  if (!draftSpeech || !$('message').value.trim()) return;
  $('draftHint').hidden = false;
  $('draftHintText').textContent = interrupted ? '途中の文字起こしです。続けて入力・編集するか、送らず消せます。Enterで改行して文を分けられます。' : '音声は下書きです。内容を確認して「記録する」を押してください。Enterで改行できます。';
}
async function clearDraft() {
  if (!unlocked() || busy) return;
  cancelWork(); clearTimeout(draftTimer); paused = active; const token = revision;
  $('message').value = ''; $('caption').textContent = ''; $('draftHint').hidden = true;
  speechChunks.clear(); speechPrefix = ''; draftSpeech = false; speechFinal = false; speechEdited = false; pausedDraftSaved = false; failedCapture = null; controls();
  await stopAudio(); if (token !== revision) return;
  try { if (record.settings?.draftPersistence) await api('/api/draft',{clear:true}); if (token === revision) status('下書きを消しました。保存済みの記録はそのままです。'); }
  catch { if (token === revision) error('画面の下書きは消しましたが、保存した下書きを消せませんでした。もう一度お試しください。'); }
}
async function pauseConversation() { paused = !paused; if (paused) { cancelWork(); await stopAudio(); status('待っています。ゆっくりどうぞ。'); showSpeechDraftHint(true); } else { error(''); controls(); await listen(); } controls(); }
async function submit(text) {
  if (busy || !unlocked() || record.inquiry?.paused || !text.trim()) return;
  cancelWork(); error(''); busy = true; controls(); const token = revision, controller = new AbortController(); chatAbort = controller;
  const payload = {text,kind:draftSpeech ? 'speech' : 'text',topic,purpose:'self_reflection',speaker:'self',...(draftSpeech ? {speechFinal,speechAccepted:true} : {})};
  const fingerprint = JSON.stringify(payload);
  if (failedCapture?.fingerprint !== fingerprint) failedCapture = {fingerprint,body:{operationId:operation(),...payload}};
  status('このMacに記録しています', true);
  try {
    const result = await api('/api/capture', failedCapture.body, {signal:controller.signal}); if (token !== revision) return;
    failedCapture = null; applyRecord(result.record); if ($('message').value === text) $('message').value = ''; $('caption').textContent = ''; $('draftHint').hidden = true; speechChunks.clear(); draftSpeech = false; speechFinal = false; speechEdited = false;
    pendingInterview = {operationId:operation(),sourceId:result.sourceId,sourceRevision:result.sourceRevision,topic,purpose:'self_reflection'};
    $('modelPreviewText').textContent = text;
    status('このMacに保存しました');
    if (record.settings?.draftPersistence) { try { await api('/api/draft', {clear:true}, {signal:controller.signal}); } catch { if (token === revision) error('発言は保存済みですが、以前の下書きを消せませんでした。'); } }
    if (token !== revision) return;
    busy = false; chatAbort = null; controls();
    if (record.consent?.model && session.provider?.connected) await runInterview();
    else if (active) { paused = true; controls(); }
  } catch (e) {
    if (controller.signal.aborted || token !== revision) return;
    error(e.message); status('保存を確認できませんでした。内容は入力欄に残っています。'); $('message').value = text; $('composer').hidden = false;
  } finally { if (chatAbort === controller) { chatAbort = null; busy = false; controls(); } }
}
function prepareSourceInterview(source) {
  selectedSource = {id:source.id,revision:source.revision,text:source.text,policy:{...source.policy}};
  $('modelPreviewText').textContent = source.text; error('', 'modelError'); show('modelPreview');
}
async function sendSelectedSource() {
  if (!selectedSource || !unlocked() || busy) return;
  if (!record.consent?.model || !session.provider?.connected) { error('設定でChatGPTに接続し、送信をオンにしてから、この発言を選び直してください。','modelError'); return; }
  if (record.inquiry?.paused) { error('「続きからはじめる」で再開してから送れます。','modelError'); return; }
  const source = {...selectedSource};
  if (!source.policy.model && !await mutate('/api/source/permission',{id:source.id,expectedRevision:source.revision,model:true},'modelError')) return;
  if (!unlocked()) return;
  const current = record.messages.find(m=>m.id===source.id);
  pendingInterview = {operationId:operation(),sourceId:source.id,sourceRevision:current?.revision || source.revision,topic,purpose:'self_reflection'};
  selectedSource = null; $('modelPreviewText').textContent = source.text; await runInterview();
}
async function loadDocument() {
  error('', 'documentError'); $('documentText').value = ''; documentRetry = null;
  const file = $('documentFile').files[0], token = revision; if (!file) return;
  if (!/\.(txt|md)$/i.test(file.name) || file.size > 1024*1024) { error('1MB以下の.txtまたは.mdファイルを選んでください。','documentError'); return; }
  try { const text = await file.text(); if (token !== revision || !unlocked()) return; if (text.includes('\u0000') || text.length > (session?.limits?.sourceChars || 50000)) throw Error('文書が長すぎるか、テキストとして読み込めません。短いテキストに分けてください。'); $('documentText').value = text; }
  catch (e) { if (token === revision) error(e.message, 'documentError'); }
}
async function captureDocument(e) {
  e.preventDefault(); if (busy || !unlocked()) return;
  const text = $('documentText').value; if (!text.trim()) { error('記録する内容を入力してください。','documentError'); return; }
  const payload = {text,kind:'document',speaker:$('documentSpeaker').value || 'unknown',topic,purpose:'self_reflection'}, fingerprint = JSON.stringify(payload);
  if (documentRetry?.fingerprint !== fingerprint) documentRetry = {fingerprint,body:{operationId:operation(),...payload}};
  cancelWork(); busy = true; controls(); const token = revision, controller = new AbortController(); chatAbort = controller; $('saveDocument').disabled = true;
  try { const result = await api('/api/capture',documentRetry.body,{signal:controller.signal}); if (token !== revision) return; applyRecord(result.record); documentRetry = null; if ($('documentText').value === text) { $('documentText').value = ''; $('documentFile').value = ''; $('documentDialog').close(); } status('文書をこのMacに保存しました。'); }
  catch (e) { if (token === revision && !controller.signal.aborted) error(e.message,'documentError'); }
  finally { if (chatAbort === controller) { chatAbort = null; busy = false; controls(); $('saveDocument').disabled = false; } }
}
async function runInterview() {
  if (busy || !unlocked() || record.inquiry?.paused || !pendingInterview || !record.consent?.model || !session.provider?.connected) return;
  const token = revision, request = {...pendingInterview}, controller = new AbortController(); chatAbort = controller; busy = true; controls(); $('modelPreview').close(); status('記録済みの発言をもとに考えています', true);
  try {
    const result = await api('/api/interview', request, {signal:controller.signal}); if (token !== revision) return;
    pendingInterview = null; applyRecord(result.record); $('caption').textContent = result.answer?.reply || '';
    if (result.answer?.pause) { active = false; paused = false; status('ここで一区切り。続きは、いつでも。'); }
    else status('保存しました。続きは、あなたのペースで。');
    if ($('readAloud').checked && active && !paused && result.assistantMessageId) await speak(result.assistantMessageId);
  } catch (e) { if (controller.signal.aborted || token !== revision) return; error(`${e.message}\n発言はこのMacに保存済みです。`); $('error').append(actionButton('保存済みの発言から続ける', () => show('modelPreview'), 'quiet')); status('発言は保存済みです'); }
  finally { if (chatAbort === controller) { chatAbort = null; busy = false; if (active) paused = true; controls(); } }
}
async function mutate(path, body, area = 'error') {
  if (busy || !unlocked()) return false;
  cancelWork(); active = false; paused = false; busy = true; controls(); error('', area);
  const token = revision, controller = new AbortController(); chatAbort = controller;
  try { const result = await api(path, {operationId:operation(),...body}, {signal:controller.signal}); if (token !== revision) return false; applyRecord(result.record); pendingInterview = null; status('保存しました'); return true; }
  catch (e) { if (!controller.signal.aborted && token === revision) error(e.message, area); return false; }
  finally { if (chatAbort === controller) { chatAbort = null; busy = false; controls(); } }
}
async function navigate(action, selectedTopic) { const done = await mutate('/api/navigate', {action,...(selectedTopic ? {topic:selectedTopic} : {}),questionId:record?.questionId}); if (done) status(action === 'refuse' ? 'この話題は、再開を選ぶまで控えます。' : '答えたいところから、どうぞ。'); }
async function reviewAssertion(a, decision) { return mutate('/api/review', {id:a.id,expectedRevision:a.revision,decision,...(decision === 'task_only' ? {taskId:currentSessionTaskId,expiresAt:new Date(Date.now()+60*60*1000).toISOString()} : {})}, 'historyError'); }
function confirmAction(title, description, callback) { $('confirmTitle').textContent = title; $('confirmText').textContent = description; error('', 'confirmError'); confirmCallback = callback; show('confirmDialog'); }
function localDate(value) { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16); }
function conditionRow(target, value = {}, contextOnly = false) {
  const row = safeNode('div', '', 'condition-row'), field = safeNode('select'), op = safeNode('select'), input = safeNode('input');
  field.setAttribute('aria-label', '条件の種類'); op.setAttribute('aria-label', '条件の一致方法'); input.setAttribute('aria-label', '条件の値');
  for (const [key,label] of Object.entries(conditionFields)) { const o = safeNode('option', label); o.value = key; field.append(o); }
  field.value = value.field || 'activity';
  for (const [key,label] of Object.entries({eq:'同じ',neq:'違う',in:'いずれかに当てはまる',not_in:'どれにも当てはまらない'})) { const o = safeNode('option', label); o.value = key; op.append(o); }
  op.value = value.op || 'eq'; op.hidden = contextOnly; input.value = Array.isArray(value.value) ? value.value.join(', ') : value.value || ''; input.placeholder = '内容（複数の場合はカンマで区切る）';
  for (const control of [field,op,input]) control.oninput = () => { if (contextOnly) invalidatePack(); };
  row.append(field, op, input, actionButton('外す', () => { row.remove(); if (contextOnly) invalidatePack(); }, 'quiet')); row.conditionInputs = {field,op,input}; $(target).append(row);
}
function readConditions(target) {
  const result = []; for (const row of $(target).children) { const {field,op,input} = row.conditionInputs; const value = input.value.trim(); if (!value) throw Error('条件の内容を入力するか、その条件を外してください。'); result.push({field:field.value,op:op.value,value:['in','not_in'].includes(op.value) ? value.split(',').map(s=>s.trim()).filter(Boolean) : value}); } return result;
}
function drawConflictChoices(id) {
  const selected = new Set(editing?.conflictsWith || []);
  const eligible = (record?.knowledge || []).filter(a=>a.id !== id && ['active','task_local'].includes(a.status)).sort((a,b)=>Number(selected.has(b.id))-Number(selected.has(a.id)));
  $('conflictChoices').replaceChildren();
  for (const a of eligible.slice(0,30)) {
    const label = safeNode('label','','check'), input = safeNode('input'); input.type = 'checkbox'; input.value = a.id; input.id = `conflict-${a.id}`; input.checked = selected.has(a.id); label.htmlFor = input.id; label.conflictInput = input;
    label.append(input,safeNode('span',a.text)); $('conflictChoices').append(label);
  }
  const visible = new Set(eligible.slice(0,30).map(a=>a.id)), hiddenSelected = [...selected].some(value=>!visible.has(value));
  $('conflictChoiceNote').textContent = !eligible.length ? '選べるほかのメモはありません。既存の設定は保持します。' : eligible.length > 30 || hiddenSelected ? '最大30件を表示しています。表示されていない既存の設定は保持します。' : '';
}
function selectedConflicts() {
  const selected = new Set(editing?.conflictsWith || []);
  for (const row of $('conflictChoices').children) { const input = row.conflictInput; if (!input) continue; if (input.checked) selected.add(input.value); else selected.delete(input.value); }
  selected.delete(editing?.id);
  if (selected.size > 30) throw Error('両立を確認するメモは30件まで選べます。');
  return [...selected];
}
function openEditor(type, item = {}) {
  editing = {type,id:item.id,revision:item.revision,validTime:{...item.validTime},conflictsWith:[...(item.conflictsWith || [])]}; drawConflictChoices(item.id); $('editorTitle').textContent = type === 'source' ? '発言を直す' : item.id ? 'メモを編集' : 'メモを作る'; $('knowledgeFields').hidden = type === 'source'; $('editText').value = item.text || ''; $('editText').maxLength = type === 'source' ? (session?.limits?.sourceChars || 50000) : 2000; $('editKind').value = item.kind || 'fact'; $('hardConstraint').checked = Boolean(item.hardConstraint);
  for (const p of purposes) if ($(`scope_${p}`)) $(`scope_${p}`).checked = (item.scope?.purposes || []).includes(p);
  $('conditionRows').replaceChildren(); for (const c of item.scope?.conditions || []) conditionRow('conditionRows', c);
  $('editExceptions').value = (item.scope?.exceptions || []).join('\n'); $('validStart').value = localDate(item.validTime?.start); $('validEnd').value = localDate(item.validTime?.end); $('validLabel').value = item.validTime?.label || ''; $('validPrecision').value = item.validTime?.precision || ''; $('sensitivity').value = item.sensitivity || 'private'; $('policyModel').checked = item.policy?.model === true; $('policyDisclosure').checked = item.policy?.disclosure === true; error('', 'editorError'); show('editor');
}
function editedDate(key) {
  const value = $(key === 'start' ? 'validStart' : 'validEnd').value, original = editing?.validTime?.[key];
  if (!value) return null;
  return original && value === localDate(original) ? original : new Date(value).toISOString();
}
async function saveEditor(e) {
  e.preventDefault(); if (!editing) return; error('', 'editorError');
  try {
    const text = $('editText').value.trim(); if (!text) throw Error('内容を入力してください。');
    const body = {text,...(editing.id ? {id:editing.id,expectedRevision:editing.revision} : {})};
    if (editing.type !== 'source') Object.assign(body, {kind:$('editKind').value,hardConstraint:$('hardConstraint').checked,conflictsWith:selectedConflicts(),scope:{purposes:purposes.filter(p=>$(`scope_${p}`)?.checked),conditions:readConditions('conditionRows'),exceptions:$('editExceptions').value.split('\n').map(s=>s.trim()).filter(Boolean)},validTime:{start:editedDate('start'),end:editedDate('end'),precision:$('validPrecision').value || (($('validStart').value || $('validEnd').value) ? 'range' : 'unknown'),label:$('validLabel').value.trim()},sensitivity:$('sensitivity').value,policy:{model:$('policyModel').checked,disclosure:$('policyDisclosure').checked}});
    if (await mutate(editing.type === 'source' ? '/api/source/edit' : '/api/knowledge/save', body, 'editorError')) { $('editor').close(); $('editText').value = ''; editing = null; }
  } catch (e) { error(e.message, 'editorError'); }
}
function showHistoryTab(name) { for (const key of ['sources','proposals','knowledge']) { $(`${key}Panel`).hidden = key !== name; $(`${key}Tab`).setAttribute('aria-pressed', String(key === name)); } }
async function previewPack(e) {
  e.preventDefault(); if (busy || !unlocked()) return; invalidatePack(); error('', 'packError');
  const purpose = $('packPurpose').value; if (!purpose) { error('用途を選んでください。', 'packError'); return; }
  cancelWork(); busy = true; controls(); const token = revision, controller = new AbortController(); chatAbort = controller;
  try {
    const context = {}; for (const c of readConditions('packConditionRows')) { if (context[c.field] !== undefined) throw Error('同じ種類の条件は1つにまとめてください。'); context[c.field] = c.value; }
    const result = await api('/api/pack/preview', {operationId:operation(),purpose,taskId:currentSessionTaskId,query:$('packQuery').value,audience:$('packAudience').value,destination:$('packDestination').value,context,limit:8},{signal:controller.signal});
    if (token !== revision || !unlocked()) return; if (result.record) applyRecord(result.record); currentPack = result.pack; $('packText').textContent = currentPack.markdown || currentPack.text || ''; $('packResult').hidden = false;
    const count = (currentPack.omitted || []).reduce((n,r)=>n+(r.count||0),0); $('packOmitted').textContent = `${currentPack.items?.length || 0}件を選びました。${count ? `用途や許可などの条件から${count}件を含めていません。` : ''}${currentPack.uncertainties?.length ? '未確定の点は出力内で確認してください。' : ''}`;
  } catch (e) { if (token === revision && !controller.signal.aborted) error(e.message, 'packError'); }
  finally { if (chatAbort === controller) { chatAbort = null; busy = false; controls(); } }
}
function download(filename, content, mime) { const url = URL.createObjectURL(new Blob([content], {type:mime})); const a = safeNode('a'); a.href = url; a.download = filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
async function exportPack(target) {
  if (!currentPack || !unlocked()) return; error('', 'packError'); const selected = {id:currentPack.id,expectedRevision:currentPack.revision,format:target === 'json' ? 'json' : 'markdown'}, token = revision;
  try { const result = await api('/api/pack/export', selected); if (token !== revision || !unlocked()) return; if (target === 'clipboard') { await navigator.clipboard.writeText(result.content); error('コピーしました。外のコピーは、このアプリでは削除できません。', 'packError'); } else download(result.filename, result.content, result.mime); }
  catch (e) { if (token === revision && unlocked()) { invalidatePack(); error(`${e.message}\n内容をもう一度確認してください。`, 'packError'); } }
}
async function backupExport() { const passphrase = $('backupPassphrase').value; $('backupPassphrase').value = ''; error('', 'backupError'); if (passphrase.length < 10) { error('10文字以上のパスフレーズを入力してください。', 'backupError'); return; } const token = revision; try { const result = await api('/api/backup/export', {passphrase}); if (token === revision && unlocked()) download(result.filename,result.content,result.mime); } catch (e) { if (token === revision && unlocked()) error(e.message, 'backupError'); } }
async function backupImport() {
  const file = $('backupFile').files[0], passphrase = $('backupPassphrase').value; $('backupPassphrase').value = ''; error('', 'backupError'); if (!file) { error('取り込むファイルを選んでください。', 'backupError'); return; } if (file.size > 64*1024*1024) { error('このファイルは大きすぎます（上限64MiB）。', 'backupError'); return; }
  const token = revision;
  try { const content = await file.text(); if (token !== revision || !unlocked()) return; if (await mutate('/api/backup/import', {content,passphrase,acknowledgeUnknownHistory:$('acknowledgeHistory').checked}, 'backupError')) { $('backupFile').value = ''; $('backupResult').textContent = '取り込みました。AIへの送信はオフです。内容を確認してから必要に応じてオンにしてください。'; } }
  catch (e) { if (token === revision && unlocked()) error(e.message, 'backupError'); }
}
async function findLegacy() { error('', 'backupError'); const token = revision; try { const result = await api('/api/legacy'); if (token !== revision || !unlocked()) return; $('legacyFiles').replaceChildren(); if (!result.files?.length) $('legacyFiles').append(safeNode('p','以前の記録は見つかりませんでした。')); for (const f of result.files || []) { const row = safeNode('div','','card'); row.append(safeNode('p',`${f.label} · ${f.answers}件`),actionButton('コピーして取り込む',async()=>{if(await mutate('/api/legacy/import',{id:f.id},'backupError')) $('backupResult').textContent='取り込みました。元のファイルはそのままです。整理案は未確認として扱います。';})); $('legacyFiles').append(row); } } catch (e) { if (token === revision && unlocked()) error(e.message, 'backupError'); } }
const voiceErrors = {speech_permission:'Macのシステム設定で、このアプリの音声認識を許可してください。',microphone_permission:'Macのシステム設定で、このアプリのマイクを許可してください。',on_device_unavailable:'このMacで日本語の音声認識を利用できません。文字で続けられます。',recognition_unavailable:'音声を認識できませんでした。文字で続けられます。',no_microphone:'マイクを確認してから、もう一度始めてください。'};
function receiveTranscript(event, token) {
  if (token !== revision || !unlocked() || !active || paused || typeof event.text !== 'string') return;
  speechChunks.set(event.turn ?? 0, {text:event.text,final:event.final === true});
  const text = [speechPrefix,...[...speechChunks.values()].map(c=>c.text)].filter(Boolean).join(' ');
  speechFinal = [...speechChunks.values()].every(c=>c.final) && !speechEdited;
  draftSpeech = true; $('message').value = text; $('caption').textContent = text; $('composer').hidden = false; showSpeechDraftHint();
  $('orb').style.setProperty('--level', String(1+Math.min(text.length%7,5)/5)); clearTimeout(settleTimer);
  if (speechFinal && endWords.test(text.trim())) { finish(); return; }
  if (speechFinal && stopWords.test(text.trim())) { pauseConversation(); return; }
  if ($('autoSend').checked && speechFinal && text.trim()) {
    settleTimer = setTimeout(() => { if (token === revision && active && !paused && !busy && speechFinal && !speechEdited && $('message').value === text && [...speechChunks.values()].every(c=>c.final)) submit(text); }, pace === 'slow' ? 4000 : 2200);
  }
}
async function listen() {
  if (!unlocked() || !active || paused || busy || !session.capabilities?.voice) return;
  stopListening(); const token = revision, controller = new AbortController(); voiceAbort = controller;
  speechPrefix = $('message').value.trim(); speechChunks = new Map(); speechEdited = false; speechFinal = false; status('聞いています。確認してから記録できます。');
  try {
    const res = await fetch('/api/voice', {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}',signal:controller.signal});
    if (!res.ok) throw Error('マイクを開始できませんでした。文字でも続けられます。');
    const reader = res.body.getReader(), decoder = new TextDecoder(); let pending = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break; if (token !== revision || controller.signal.aborted) return;
      pending += decoder.decode(chunk.value,{stream:true}); if (pending.length > 100000) throw Error('音声の受信を止めました。入力内容を確認してください。');
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0,index); pending = pending.slice(index+1); if (!line.trim()) continue;
        const event = JSON.parse(line); if (token !== revision || controller.signal.aborted) return;
        if (event.type === 'error') throw Error(voiceErrors[event.code] || '音声を開始できませんでした。文字でも続けられます。');
        if (event.type === 'transcript') receiveTranscript(event,token);
      }
    }
    if (!controller.signal.aborted && token === revision) { paused = true; status('音声を止めました。下書きを確認できます。'); showSpeechDraftHint(true); controls(); }
  } catch (e) { if (controller.signal.aborted || token !== revision) return; paused = true; status('音声をいったん止めました'); error(e.message); $('composer').hidden = false; showSpeechDraftHint(true); controls(); }
  finally { if (voiceAbort === controller) voiceAbort = null; }
}
async function speak(messageId) { if (!unlocked()) return; const controller = new AbortController(), token = revision; speakAbort = controller; try { await api('/api/speak',{messageId},{signal:controller.signal}); } catch { if (!controller.signal.aborted && token === revision) error('読み上げを再生できませんでした。画面で返答を確認できます。'); } finally { if (speakAbort === controller) speakAbort = null; } }
async function setConsent(enabled) {
  if (!unlocked()) return;
  if (!enabled) { cancelWork(); await stopAudio(); }
  if (await mutate('/api/consent', {enabled}, 'consentError')) { $('consentDialog').close(); status(enabled ? 'ChatGPTへの送信をオンにしました。' : '新たな送信を止めました。'); }
}
async function connectProvider() {
  if (!unlocked() || signingIn) return;
  error('', 'settingsError'); const popup = window.open('about:blank', 'hitotsuzutsu-signin'); if (popup) popup.opener = null;
  signingIn = true; controls(); const token = revision;
  try {
    await api('/api/auth/start', {}); let opened = false, polling = false; const until = Date.now()+10*60*1000;
    authPoll = setInterval(async()=>{
      if (polling) return;
      if (token !== revision || !unlocked()) { clearInterval(authPoll); authPoll = null; signingIn = false; popup?.close(); controls(); return; }
      polling = true;
      try {
        const pending = await api('/api/auth/pending');
        if (token !== revision) return;
        if (pending.url && !opened) { const url = new URL(pending.url); if (url.protocol !== 'https:') throw Error('サインイン先を確認できませんでした。'); opened = true; if (popup && !popup.closed) popup.location.href = url.href; else { const link = safeNode('a','ChatGPTのサインインを開く'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('settingsError').replaceChildren(link); } }
        const next = await api('/api/status'); if (token !== revision) return;
        session = next; csrf = next.csrf;
        if (next.provider?.connected || pending.errorCode || Date.now()>until) { clearInterval(authPoll); authPoll = null; signingIn = false; popup?.close(); if (next.provider?.connected) { error('', 'settingsError'); status('接続しました。送信は設定から選べます。'); } else error('サインインを完了できませんでした。もう一度試せます。', 'settingsError'); }
        controls();
      } catch (e) { clearInterval(authPoll); authPoll = null; signingIn = false; popup?.close(); if (token === revision) { error(e.message,'settingsError'); controls(); } }
      finally { polling = false; }
    },1000);
  } catch (e) { popup?.close(); signingIn = false; error(e.message,'settingsError'); controls(); }
}
async function disconnectProvider() { clearPrivate(); if (session?.vault) session.vault.unlocked = false; controls(); try { await api('/api/auth/disconnect', {}); await api('/api/vault/lock', {}); if (session?.provider) session.provider.connected = false; controls(); status('ChatGPTとの接続を解除し、記録をロックしました。'); } catch { error('接続解除を確認できませんでした。記録をロックして、もう一度お試しください。'); } }
function openSettings() {
  if (record) { $('draftPersistence').checked = record.settings?.draftPersistence === true; $('retentionDays').value = record.settings?.retentionDays == null ? '' : String(record.settings.retentionDays); $('toolQuestion').checked = record.settings?.showPrivateQuestionToTools === true; $('topic').value = topic; }
  error('', 'settingsError'); show('settings');
}
async function saveSettings() {
  const nextTopic = $('topic').value; pace = $('pace').value;
  const done = await mutate('/api/settings', {draftPersistence:$('draftPersistence').checked,retentionDays:$('retentionDays').value ? Number($('retentionDays').value) : null,showPrivateQuestionToTools:$('toolQuestion').checked}, 'settingsError');
  if (done) { if (nextTopic && nextTopic !== topic) await navigate('topic', nextTopic); if (!$('error').textContent) $('settings').close(); }
}
function saveDraftLater() {
  pausedDraftSaved = false; controls(); touch(); clearTimeout(draftTimer); clearTimeout(settleTimer);
  if (draftSpeech) { speechEdited = true; speechFinal = false; stopListening(); paused = active; showSpeechDraftHint(true); controls(); return; }
  if (!record?.settings?.draftPersistence) return;
  const token = revision;
  draftTimer = setTimeout(async()=>{ if (token !== revision || !unlocked() || draftSpeech) return; draftAbort?.abort(); const controller = new AbortController(); draftAbort = controller; const text = $('message').value; try { await api('/api/draft',{text},{signal:controller.signal}); if (token === revision && !controller.signal.aborted && $('message').value === text) { pausedDraftSaved = true; controls(); } } catch { if (token === revision && !controller.signal.aborted) error('下書きを保存できませんでした。入力欄には残っています。'); } finally { if (draftAbort === controller) draftAbort = null; } },700);
}
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
$('vaultForm').onsubmit = openWithPassphrase;
$('unlockButton').onclick = openVault;
$('recoverMode').onclick = () => { recoverMode = !recoverMode; $('recoveryInputLabel').hidden = !recoverMode; $('vaultTitle').textContent = recoverMode ? '記録を復旧する' : '記録を開く'; $('vaultIntro').textContent = recoverMode ? '復旧コードと、新しいパスフレーズを入力してください。' : 'パスフレーズを入力してください。'; $('vaultSubmit').textContent = recoverMode ? '復旧する' : '開く'; $('recoverMode').textContent = recoverMode ? 'パスフレーズに戻る' : '復旧コードを使う'; $('passphrase').value = ''; $('recoveryInput').value = ''; };
$('recoveryDone').onclick = () => { $('recoveryCode').textContent = ''; $('recoveryDialog').close(); };
$('recoveryDialog').oncancel = () => { $('recoveryCode').textContent = ''; };
$('settingsButton').onclick = openSettings;
$('historyButton').onclick = () => { if (unlocked()) { drawRecord(); show('history'); } };
for (const key of ['sources','proposals','knowledge']) $(`${key}Tab`).onclick = () => showHistoryTab(key);
$('moreProposals').onclick = () => { proposalOffset += 3; drawProposals(); };
$('importDocument').onclick = () => { $('documentSpeaker').value = 'unknown'; error('', 'documentError'); show('documentDialog'); };
$('documentFile').onchange = loadDocument;
$('documentForm').onsubmit = captureDocument;
$('documentDialog').onclose = () => { $('documentText').value = ''; $('documentFile').value = ''; documentRetry = null; };
$('newKnowledge').onclick = () => openEditor('knowledge');
$('editorForm').onsubmit = saveEditor;
$('editor').onclose = () => { editing = null; for (const id of ['editText','editExceptions','validStart','validEnd','validLabel','validPrecision']) $(id).value = ''; $('conditionRows').replaceChildren(); $('conflictChoices').replaceChildren(); $('conflictChoiceNote').textContent = ''; };
$('backupDialog').onclose = () => { $('backupPassphrase').value = ''; $('backupFile').value = ''; };
$('vaultDialog').onclose = () => { $('passphrase').value = ''; $('recoveryInput').value = ''; };
$('addCondition').onclick = () => conditionRow('conditionRows');
$('addPackCondition').onclick = () => { invalidatePack(); conditionRow('packConditionRows',{},true); };
$('confirmAction').onclick = async () => { if (!confirmCallback) return; const callback = confirmCallback; if (await callback()) { $('confirmDialog').close(); confirmCallback = null; } };
$('start').onclick = () => { if (!unlocked() || busy || record.inquiry?.paused) return; error(''); active = true; paused = false; revision++; controls(); listen(); };
$('pause').onclick = pauseConversation;
$('finish').onclick = finish;
$('resumeSession').onclick = resumeSession;
$('savePausedDraft').onclick = savePausedDraft;
$('textMode').onclick = async () => { cancelWork(); active = false; paused = false; await stopAudio(); $('composer').hidden = false; controls(); status('文字で、そのままどうぞ。'); $('message').focus(); };
$('composer').onsubmit = e => { e.preventDefault(); submit($('message').value); };
$('message').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } };
$('message').oninput = saveDraftLater;
$('clearDraft').onclick = clearDraft;
$('skip').onclick = () => navigate('skip');
$('refuse').onclick = () => navigate('refuse', topic);
$('applySettings').onclick = saveSettings;
$('connect').onclick = connectProvider;
$('cancelAuth').onclick = async () => { clearInterval(authPoll); authPoll = null; signingIn = false; try { await api('/api/auth/cancel',{}); } catch { error('接続の中止を確認できませんでした。','settingsError'); } controls(); };
$('disconnect').onclick = disconnectProvider;
$('lock').onclick = () => lockVault();
$('consentButton').onclick = () => show('consentDialog');
$('enableConsent').onclick = () => setConsent(true);
$('disableConsent').onclick = () => setConsent(false);
$('modelPreview').onclose = () => { selectedSource = null; };
$('retryInterview').onclick = () => selectedSource ? sendSelectedSource() : runInterview();
$('useContext').onclick = () => { invalidatePack(); if (!$('packAudience').value) $('packAudience').value = 'self'; if (!$('packDestination').value) $('packDestination').value = 'clipboard'; show('packDialog'); };
$('packForm').onsubmit = previewPack;
for (const id of ['packPurpose','packQuery','packAudience','packDestination','documentText','documentFile']) $(id).oninput = invalidatePack;
$('copyPack').onclick = () => exportPack('clipboard');
$('downloadPack').onclick = () => exportPack('markdown');
$('jsonPack').onclick = () => exportPack('json');
$('backupButton').onclick = () => { if (unlocked()) { $('backupPassphrase').value = ''; $('backupResult').textContent = ''; error('','backupError'); show('backupDialog'); } };
$('exportBackup').onclick = backupExport;
$('importBackup').onclick = backupImport;
$('findLegacy').onclick = findLegacy;
window.addEventListener('pointerdown',touch); window.addEventListener('keydown',touch);
window.addEventListener('pagehide', () => { clearPrivate(); });
const mc = document.modelContext;
if (mc?.registerTool) {
  const life = new AbortController();
  const tools = [
    {name:'read_current_interview',title:'会話の状態を見る',description:'Read lock and pause status. A private question is returned only when the user has explicitly enabled that setting. No answers or credentials are returned.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:()=>({locked:!unlocked(),active,paused:paused || record?.inquiry?.paused === true,...(unlocked() && record.settings?.showPrivateQuestionToTools === true ? {question:record.question} : {})})},
    {name:'pause_interview',title:'会話を一時停止',description:'Pause microphone capture and speech without saving or sending the draft.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false},execute:async()=>{if(active&&!paused)await pauseConversation();return {paused:paused||!active};}}
  ];
  for (const tool of tools) { try { Promise.resolve(mc.registerTool(tool,{signal:life.signal})).catch(()=>{}); } catch {} }
  window.addEventListener('pagehide',()=>life.abort(),{once:true});
}
refresh().catch(() => { status('接続できませんでした'); error('この画面を開き直してください。'); });
