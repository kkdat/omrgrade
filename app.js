/* OMR AutoGrader — Offline Classroom Edition
 * All data stays in this browser (localStorage). No network calls at runtime.
 */
(function () {
  'use strict';

  const KEYS = {
    sections: 'omr:sections',
    records: 'omr:records',
    rosters: 'omr:rosters',
    settings: 'omr:settings'
  };
  const SCAN_INTERVAL_MS = 650;
  const STABLE_HITS_REQUIRED = 3;
  const COOLDOWN_MS = 2200;
  const MAX_ITEMS = 40;              // sheet geometry: 2 columns x 20 rows
  const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E'];

  const state = {
    sections: {},
    records: [],
    rosters: {},
    settings: { passMark: 75 },
    editorSelections: {},

    cameraMode: null,
    activeSection: null,
    isCameraActive: false,
    videoStream: null,
    isOpenCvLoaded: false,
    scanTimer: null,
    cooldownUntil: 0,
    lastSig: null,
    stableHits: 0,
    pending: null,
    photoMode: null,
    openItems: new Set(),
    reportId: null,
    lastAnalysis: null,
    deferredInstall: null
  };

  const App = {};

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function variance(arr) {
    if (arr.length < 2) return 0;
    const m = avg(arr);
    return arr.reduce((a, v) => a + (v - m) * (v - m), 0) / (arr.length - 1);
  }
  function stddev(arr) { return Math.sqrt(variance(arr)); }
  function round(n, d) { const f = Math.pow(10, d || 0); return Math.round(n * f) / f; }
  function fmtPct(n) { return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '') + '%'; }

  function toast(msg, tone) {
    const el = $('page-toast');
    el.textContent = msg;
    el.className = 'page-toast show' + (tone ? ' ' + tone : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'page-toast' + (tone ? ' ' + tone : ''); }, 4200);
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        toast('Could not save — this browser\'s storage is full or blocked. Use Backup to keep your data.', 'error');
        return false;
      }
    }
  };

  function normalizeRecord(r) {
    let correct = r.correct;
    let total = r.total;
    if ((correct == null || total == null) && typeof r.score === 'string') {
      const parts = r.score.split('/');
      correct = parseInt(parts[0], 10) || 0;
      total = parseInt(parts[1], 10) || 0;
    }
    if (total == null) total = 0;
    correct = correct || 0;
    let pct = typeof r.percentage === 'number' ? r.percentage : parseFloat(String(r.percentage || ''));
    if (!isFinite(pct)) pct = total ? (correct / total) * 100 : 0;
    return {
      id: r.id || Date.now() + Math.random(),
      ts: r.ts || null,
      timestamp: r.timestamp || '',
      studentId: r.studentId || '',
      name: r.name || 'Unnamed',
      section: r.section || '',
      correct,
      total,
      percentage: pct,
      answers: r.answers || {},
      ambiguous: r.ambiguous || []
    };
  }

  function loadState() {
    const sections = store.get(KEYS.sections, {});
    state.sections = sections && typeof sections === 'object' ? sections : {};
    const records = store.get(KEYS.records, []);
    state.records = Array.isArray(records) ? records.map(normalizeRecord) : [];
    const rosters = store.get(KEYS.rosters, {});
    state.rosters = rosters && typeof rosters === 'object' ? rosters : {};
    const settings = store.get(KEYS.settings, {});
    state.settings = Object.assign({ passMark: 75 }, settings || {});
    $('pass-mark').value = state.settings.passMark;
  }

  const saveSections = () => store.set(KEYS.sections, state.sections);
  const saveRecords = () => store.set(KEYS.records, state.records);
  const saveRosters = () => store.set(KEYS.rosters, state.rosters);
  const saveSettings = () => store.set(KEYS.settings, state.settings);

  /* ------------------------------------------------------------------ *
   * Engine loading
   * ------------------------------------------------------------------ */
  function setCvStatus(text, tone, clickable) {
    const el = $('cv-status');
    const tones = {
      wait: 'text-[11px] px-2 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30',
      ok: 'text-[11px] px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
      err: 'text-[11px] px-2 py-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30'
    };
    el.className = tones[tone] || tones.wait;
    el.textContent = text;
    el.style.cursor = clickable ? 'pointer' : 'default';
    el.onclick = clickable ? () => location.reload() : null;
    el.title = clickable ? 'Tap to reload the page' : '';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, 60000);
      s.onload = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      s.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('load')); } };
      document.head.appendChild(s);
    });
  }

  function waitForCv(tries) {
    return new Promise((resolve) => {
      const tick = () => {
        let ready = false;
        try { ready = !!(window.cv && window.cv.Mat); } catch (e) { ready = false; }
        if (ready) return resolve(true);
        if (tries-- <= 0) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function initEngine() {
    const sources = ['vendor/opencv.js', 'https://docs.opencv.org/4.7.0/opencv.js'];
    for (let i = 0; i < sources.length; i++) {
      try {
        await loadScript(sources[i]);
      } catch (e) { continue; }
      const ready = await waitForCv(400);
      if (ready) {
        state.isOpenCvLoaded = true;
        setCvStatus('Reader ready', 'ok', false);
        refreshGradeButtonState();
        return;
      }
    }
    setCvStatus('Reader failed — reload', 'err', true);
    toast('The sheet reader could not start. Check that vendor/opencv.js is next to index.html, then reload.', 'error');
  }

  /* ------------------------------------------------------------------ *
   * Tabs
   * ------------------------------------------------------------------ */
  App.switchTab = function (tab) {
    ['generator', 'scanner', 'students', 'analysis'].forEach((t) => {
      $('sec-' + t).classList.add('hidden');
      $('tab-' + t).className = 'px-2 sm:px-3 py-2 rounded-lg text-[11px] sm:text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700';
    });
    $('sec-' + tab).classList.remove('hidden');
    $('tab-' + tab).className = 'px-2 sm:px-3 py-2 rounded-lg text-[11px] sm:text-sm font-medium aurora-btn text-white';
    if (tab === 'students') { renderRoster(); updateRecordsTable(); }
    if (tab === 'analysis') { autoPickAnalysisSection(); App.renderAnalysis(); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /* ------------------------------------------------------------------ *
   * Key editor
   * ------------------------------------------------------------------ */
  App.buildKeyEditor = function (prefillKey) {
    const count = clamp(parseInt($('key-item-count').value, 10) || 20, 5, MAX_ITEMS);
    const choicesCount = parseInt($('key-choices-count').value, 10) || 4;
    $('key-item-count').value = count;
    const choices = CHOICE_LETTERS.slice(0, choicesCount);
    const container = $('key-container');
    state.editorSelections = {};
    let html = '';

    for (let i = 1; i <= count; i++) {
      const preset = prefillKey && prefillKey[i] ? prefillKey[i] : 'A';
      state.editorSelections[i] = preset;
      const bubbles = choices.map((c) => `
        <button type="button" onclick="App.selectKeyOption(${i}, '${c}', this)"
          class="key-bubble key-btn-${i} w-7 h-7 rounded-full border border-slate-600 text-xs font-semibold text-slate-300 hover:border-indigo-400 ${c === preset ? 'selected' : ''}">
          ${c}
        </button>`).join('');

      html += `
        <div class="flex items-center justify-between py-1 px-2 rounded bg-slate-900/40 border border-slate-800">
          <span class="text-xs font-medium text-indigo-200">Q${i}</span>
          <div class="flex space-x-1">${bubbles}</div>
        </div>`;
    }
    container.innerHTML = html;
    updateKeySummary();
  };

  function updateKeySummary() {
    const count = parseInt($('key-item-count').value, 10) || 20;
    const choices = parseInt($('key-choices-count').value, 10) || 4;
    $('key-summary').textContent = count + ' items · ' + choices + ' choices';
  }

  App.selectKeyOption = function (item, choice, el) {
    state.editorSelections[item] = choice;
    document.querySelectorAll('.key-btn-' + item).forEach((b) => b.classList.remove('selected'));
    el.classList.add('selected');
  };

  App.setAllKeyAnswers = function (letter) {
    const count = parseInt($('key-item-count').value, 10) || 20;
    for (let i = 1; i <= count; i++) {
      state.editorSelections[i] = letter;
      document.querySelectorAll('.key-btn-' + i).forEach((b) => {
        b.classList.toggle('selected', b.textContent.trim() === letter);
      });
    }
  };

  function refreshSectionDropdowns() {
    const names = Object.keys(state.sections).sort((a, b) => a.localeCompare(b));
    const keep = (el, placeholder, build) => {
      const prev = el.value;
      el.innerHTML = placeholder + names.map(build).join('');
      if (prev && names.includes(prev)) el.value = prev;
    };

    keep($('section-select'), '<option value="">— New key —</option>', (n) =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`);

    keep($('grade-section-select'), names.length ? '' : '<option value="">— No saved keys yet —</option>', (n) =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)} (${state.sections[n].itemCount} items)</option>`);

    keep($('records-filter'), '<option value="">All sections</option>', (n) =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`);

    keep($('analysis-section-select'), '<option value="">— Select a section —</option>', (n) =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`);

    const rosterSel = $('roster-section');
    const prevRoster = rosterSel.value;
    rosterSel.innerHTML = names.length
      ? names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
      : '<option value="">— Save an answer key first —</option>';
    if (prevRoster && names.includes(prevRoster)) rosterSel.value = prevRoster;

    refreshGradeButtonState();
    onGradeSectionChange();
    renderRoster();
  }

  function refreshGradeButtonState() {
    const btn = $('start-grading-btn');
    if (!btn) return;
    btn.disabled = !$('grade-section-select').value || !state.isOpenCvLoaded;
  }

  function onGradeSectionChange() {
    const name = $('grade-section-select').value;
    const hint = $('grade-key-hint');
    const cfg = state.sections[name];
    if (!cfg) { hint.textContent = '—'; return; }
    const graded = sectionRecords(name).length;
    const rosterSize = Object.keys(state.rosters[name] || {}).length;
    hint.textContent = `${cfg.itemCount} items · ${cfg.choicesCount} choices · ${graded} graded` +
      (rosterSize ? ` · roster ${rosterSize}` : ' · no roster yet');
  }

  App.loadSectionIntoEditor = function (name) {
    $('key-section-name').value = name || '';
    if (!name || !state.sections[name]) {
      $('key-item-count').value = 20;
      $('key-choices-count').value = '4';
      App.buildKeyEditor();
      return;
    }
    const s = state.sections[name];
    $('key-item-count').value = s.itemCount;
    $('key-choices-count').value = String(s.choicesCount);
    App.buildKeyEditor(s.key);
  };

  App.saveCurrentKey = function () {
    const name = $('key-section-name').value.trim();
    if (!name) { toast('Give this section / exam a name first.', 'warn'); return; }
    const itemCount = clamp(parseInt($('key-item-count').value, 10) || 20, 5, MAX_ITEMS);
    const choicesCount = parseInt($('key-choices-count').value, 10) || 4;
    state.sections[name] = {
      itemCount,
      choicesCount,
      key: Object.assign({}, state.editorSelections),
      updatedAt: new Date().toISOString()
    };
    saveSections();
    refreshSectionDropdowns();
    $('section-select').value = name;
    $('grade-section-select').value = name;
    refreshGradeButtonState();
    onGradeSectionChange();
    toast(`Answer key saved for “${name}”.`);
  };

  App.deleteCurrentSection = function () {
    const name = $('key-section-name').value.trim();
    if (!name || !state.sections[name]) { toast('No saved section selected.', 'warn'); return; }
    if (!confirm(`Delete the answer key for “${name}”?\n\nScanned results stay in Students, but you will not be able to grade against this key until you save it again.`)) return;
    delete state.sections[name];
    saveSections();
    refreshSectionDropdowns();
    App.loadSectionIntoEditor('');
    toast('Answer key deleted.', 'warn');
  };

  App.exportKey = function () {
    const name = $('key-section-name').value.trim();
    const cfg = state.sections[name];
    if (!cfg) { toast('Save the key first, then share it.', 'warn'); return; }
    const payload = {
      type: 'omr-key',
      version: 2,
      exportedAt: new Date().toISOString(),
      section: name,
      itemCount: cfg.itemCount,
      choicesCount: cfg.choicesCount,
      key: cfg.key
    };
    downloadBlob(JSON.stringify(payload, null, 2),
      'answer-key-' + name.replace(/[^a-z0-9\-]+/gi, '_') + '.json', 'application/json');
    toast('Answer key file downloaded — open it in another device with Restore.');
  };

  /* ------------------------------------------------------------------ *
   * PDF
   * ------------------------------------------------------------------ */
  App.generateSheet = function () {
    const itemCount = parseInt($('gen-item-count').value, 10) || 20;
    if (itemCount < 5 || itemCount > MAX_ITEMS) {
      toast(`This sheet layout holds 5 to ${MAX_ITEMS} items. For longer tests, split into parts.`, 'warn');
      return;
    }
    try {
      OMR.generatePDFSheet({
        itemCount,
        choicesCount: parseInt($('gen-choices-count').value, 10) || 4,
        markAsKey: $('gen-mark-key').checked,
        examTitle: $('gen-title').value
      });
      toast('Sheet downloaded. Print at 100% size (no “fit to page”).');
    } catch (e) {
      console.error(e);
      toast('Could not create the PDF: ' + e.message, 'error');
    }
  };

  /* ------------------------------------------------------------------ *
   * Camera + scanning
   * ------------------------------------------------------------------ */
  const dotColors = { amber: 'bg-amber-400', blue: 'bg-blue-400', emerald: 'bg-emerald-400 pulse-live', rose: 'bg-rose-400' };
  const textColors = { amber: 'text-amber-300', blue: 'text-blue-300', emerald: 'text-emerald-300', rose: 'text-rose-300', slate: 'text-slate-400' };

  function setStatus(text, tone) {
    $('scan-status').textContent = text;
    $('scan-status-dot').className = 'status-dot ' + (dotColors[tone] || 'bg-amber-400');
  }
  function setModalToast(text, tone) {
    const el = $('scan-toast');
    el.textContent = text;
    el.className = 'mt-3 text-sm font-semibold text-center py-2 px-2 rounded-lg bg-slate-900/60 border border-slate-800 ' +
      (textColors[tone] || 'text-slate-400');
  }

  function showConfirmRow(label) {
    $('confirm-primary').innerHTML = '<i class="fa-solid fa-check mr-2"></i>' + label;
    $('confirm-row').classList.remove('hidden');
  }
  function hideConfirmRow() {
    $('confirm-row').classList.add('hidden');
    state.pending = null;
  }

  App.openCameraModal = async function (mode) {
    if (!state.isOpenCvLoaded) { toast('The sheet reader is still starting — try again in a moment.', 'warn'); return; }
    state.cameraMode = mode;
    hideConfirmRow();

    if (mode === 'grade') {
      state.activeSection = $('grade-section-select').value;
      if (!state.activeSection || !state.sections[state.activeSection]) {
        toast('Pick a section with a saved key first.', 'warn');
        return;
      }
      $('modal-title').textContent = 'Grading against “' + state.activeSection + '”';
    } else {
      $('modal-title').textContent = 'Scan the filled-in answer key sheet';
    }

    resetScanState();
    setStatus('Looking for the sheet\'s 4 corner markers…', 'amber');
    setModalToast(mode === 'key' ? 'Fill in the key sheet and hold it steady.' : 'Waiting for the first scan…', 'slate');
    $('manual-capture-btn').classList.remove('hidden');

    $('camera-modal').classList.remove('hidden');
    $('camera-modal').classList.add('flex');
    await startCamera();
    startScanLoop();
  };

  App.closeCameraModal = function () {
    stopScanLoop();
    stopCamera();
    hideConfirmRow();
    $('camera-modal').classList.add('hidden');
    $('camera-modal').classList.remove('flex');
    state.cameraMode = null;
  };

  async function startCamera() {
    const video = $('webcam');
    try {
      state.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      video.srcObject = state.videoStream;
      await video.play();
      state.isCameraActive = true;
      renderCameraToCanvas();
    } catch (err) {
      toast('Camera not available: ' + err.message + ' — you can grade photos instead.', 'error');
      App.closeCameraModal();
    }
  }

  function stopCamera() {
    if (state.videoStream) state.videoStream.getTracks().forEach((t) => t.stop());
    state.videoStream = null;
    state.isCameraActive = false;
  }

  function renderCameraToCanvas() {
    if (!state.isCameraActive) return;
    const video = $('webcam');
    const canvas = $('scan-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    requestAnimationFrame(renderCameraToCanvas);
  }

  function resetScanState() {
    state.lastSig = null;
    state.stableHits = 0;
    state.cooldownUntil = 0;
  }

  function startScanLoop() {
    stopScanLoop();
    state.scanTimer = setInterval(tickScan, SCAN_INTERVAL_MS);
  }
  function stopScanLoop() {
    if (state.scanTimer) clearInterval(state.scanTimer);
    state.scanTimer = null;
  }

  function currentCfg() {
    if (state.cameraMode === 'key') {
      return {
        itemCount: clamp(parseInt($('key-item-count').value, 10) || 20, 5, MAX_ITEMS),
        choicesCount: parseInt($('key-choices-count').value, 10) || 4
      };
    }
    return state.sections[state.activeSection];
  }

  function tickScan() {
    if (!state.isOpenCvLoaded || !state.isCameraActive) return;
    if (Date.now() < state.cooldownUntil) return;
    const cfg = currentCfg();
    if (!cfg) return;

    let result;
    try {
      result = OMR.runOMREngine('scan-canvas', cfg.itemCount, cfg.choicesCount);
    } catch (e) {
      return; // transient frame issue — try the next tick
    }

    if (!result.aligned) {
      state.stableHits = 0;
      state.lastSig = null;
      setStatus('Looking for the sheet\'s 4 corner markers…', 'amber');
      return;
    }

    const sig = JSON.stringify(result.detected) + '_' + result.studentId;
    state.stableHits = (sig === state.lastSig) ? state.stableHits + 1 : 1;
    state.lastSig = sig;

    drawPreview(result, cfg);
    setStatus(`Sheet aligned — hold steady (${Math.min(state.stableHits, STABLE_HITS_REQUIRED)}/${STABLE_HITS_REQUIRED})`, 'blue');

    if (state.stableHits >= STABLE_HITS_REQUIRED) finalizeCapture(result, cfg);
  }

  App.manualCapture = function () {
    if (!state.isOpenCvLoaded) { toast('The sheet reader is still starting.', 'warn'); return; }
    const cfg = currentCfg();
    if (!cfg) return;
    let result;
    try { result = OMR.runOMREngine('scan-canvas', cfg.itemCount, cfg.choicesCount); }
    catch (e) { toast('Could not read that frame — try again.', 'error'); return; }
    drawPreview(result, cfg);
    finalizeCapture(result, cfg);
  };

  function finalizeCapture(result, cfg) {
    if (!result.aligned) {
      setStatus('Sheet not fully visible — show all four black corners.', 'rose');
      setModalToast('Could not lock onto the corner markers. Move the sheet fully into view on a plain background.', 'rose');
      return;
    }

    if (state.cameraMode === 'key') {
      stopScanLoop();
      state.pending = { kind: 'key', result, cfg };
      showConfirmRow('Use this detected key');
      setStatus('Key captured — review the preview, then apply it.', 'emerald');
      setModalToast('Detected key: ' + keyPreviewText(result, cfg), 'emerald');
      return;
    }

    const outcome = saveGradeRecord(result, cfg);
    beep();
    if (navigator.vibrate) navigator.vibrate(80);
    setModalToast(outcome.toast, outcome.duplicate ? 'amber' : 'emerald');
    setStatus('Saved. Swap in the next sheet…', 'amber');
    if (outcome.note) setStatus(outcome.note, 'rose');
    state.stableHits = 0;
    state.lastSig = null;
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  function keyPreviewText(result, cfg) {
    const parts = [];
    for (let i = 1; i <= cfg.itemCount; i++) parts.push(result.detected[i] || '?');
    const blanks = parts.filter((p) => p === 'N/A' || p === '?').length;
    return parts.slice(0, 8).join(' ') + (cfg.itemCount > 8 ? ' …' : '') +
      (blanks ? ` (${blanks} blank${blanks === 1 ? '' : 's'})` : '');
  }

  App.confirmPending = function () {
    const pending = state.pending;
    if (!pending) return;
    if (pending.kind === 'key') {
      applyScannedKey(pending);
    } else {
      const outcome = saveGradeRecord(pending.result, pending.cfg);
      beep();
      toast(outcome.toast, outcome.duplicate ? 'warn' : '');
      App.closeCameraModal();
    }
  };

  App.discardPending = function () {
    const fromPhoto = !state.isCameraActive;
    hideConfirmRow();
    if (fromPhoto) { App.closeCameraModal(); return; }
    if (state.cameraMode) {
      setStatus('Looking for the sheet\'s 4 corner markers…', 'amber');
      setModalToast('Discarded. Try again.', 'slate');
      if (state.isCameraActive) startScanLoop();
    }
  };

  function applyScannedKey(pending) {
    const cfg = pending.cfg;
    $('key-item-count').value = cfg.itemCount;
    $('key-choices-count').value = String(cfg.choicesCount);
    App.buildKeyEditor(pending.result.detected);
    App.closeCameraModal();
    App.switchTab('scanner');
    const blanks = Object.values(pending.result.detected).filter((v) => v === 'N/A' || !v).length;
    toast(blanks
      ? `Key detected with ${blanks} blank item${blanks === 1 ? '' : 's'} — fix those bubbles, then Save Key.`
      : 'Key detected. Review the bubbles, then click Save Key.', blanks ? 'warn' : '');
  }

  /* ------------------------------------------------------------------ *
   * Photo grading (no webcam needed)
   * ------------------------------------------------------------------ */
  App.pickPhoto = function (mode) {
    if (!state.isOpenCvLoaded) { toast('The sheet reader is still starting — try again in a moment.', 'warn'); return; }
    if (mode === 'grade') {
      state.activeSection = $('grade-section-select').value;
      if (!state.activeSection || !state.sections[state.activeSection]) {
        toast('Pick a section with a saved key first.', 'warn');
        return;
      }
    }
    state.photoMode = mode;
    const input = $('photo-input');
    input.value = '';
    input.click();
  };

  async function handlePhoto(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = $('scan-canvas');
        const maxW = 1400;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

        state.cameraMode = state.photoMode;
        $('camera-modal').classList.remove('hidden');
        $('camera-modal').classList.add('flex');
        $('manual-capture-btn').classList.add('hidden');
        setStatus('Reading the photo…', 'blue');
        setModalToast('Reading the photo…', 'slate');
        stopCamera();
        stopScanLoop();
        hideConfirmRow();

        const cfg = currentCfg();
        const result = OMR.runOMREngine('scan-canvas', cfg.itemCount, cfg.choicesCount);

        if (state.cameraMode === 'key') {
          $('modal-title').textContent = 'Answer key from photo';
        } else {
          $('modal-title').textContent = 'Grading against “' + state.activeSection + '”';
        }

        if (!result.aligned) {
          setStatus('Sheet not found in this photo.', 'rose');
          setModalToast('Could not find the four black corner markers. Retake the photo with the whole sheet visible, flat and well lit.', 'rose');
          return;
        }

        drawPreview(result, cfg);

        if (state.cameraMode === 'key') {
          state.pending = { kind: 'key', result, cfg };
          showConfirmRow('Use this detected key');
          setStatus('Key read from photo.', 'emerald');
          setModalToast('Detected key: ' + keyPreviewText(result, cfg), 'emerald');
        } else {
          const preview = previewGrade(result, cfg);
          state.pending = { kind: 'grade', result, cfg };
          showConfirmRow('Save this result');
          setStatus('Sheet read from photo.', 'emerald');
          setModalToast(preview.text, preview.warn ? 'amber' : 'emerald');
        }
      } catch (err) {
        console.error(err);
        toast('Could not process that image: ' + err.message, 'error');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('That file is not a readable image.', 'error');
    };
    img.src = url;
  }

  /* ------------------------------------------------------------------ *
   * Grading
   * ------------------------------------------------------------------ */
  function rosterNameFor(section, studentId) {
    const roster = state.rosters[section];
    if (!roster || !studentId) return null;
    return roster[studentId] || null;
  }

  function previewGrade(result, cfg) {
    const key = state.sections[state.activeSection].key;
    let correct = 0;
    for (let i = 1; i <= cfg.itemCount; i++) if (result.detected[i] === key[i]) correct++;
    const pct = (correct / cfg.itemCount) * 100;
    const idOk = /^\d{7}$/.test(result.studentId || '');
    const name = rosterNameFor(state.activeSection, result.studentId) || (idOk ? 'Student ' + result.studentId : 'Unidentified sheet');
    const warn = !idOk || (result.ambiguous && result.ambiguous.length > 0);
    return {
      correct,
      pct,
      name,
      warn,
      text: `${name} — ${correct}/${cfg.itemCount} (${fmtPct(pct)})` +
        (!idOk ? ' · ID unreadable' : '') +
        (result.ambiguous && result.ambiguous.length ? ' · check Q' + result.ambiguous.slice(0, 4).join(', Q') : '')
    };
  }

  function saveGradeRecord(result, cfg) {
    const section = state.activeSection;
    const key = state.sections[section].key;
    let correct = 0;
    for (let i = 1; i <= cfg.itemCount; i++) if (result.detected[i] === key[i]) correct++;
    const total = cfg.itemCount;
    const pct = (correct / total) * 100;
    const idOk = /^\d{7}$/.test(result.studentId || '');
    const studentId = idOk ? result.studentId : 'Unknown';
    const rosName = rosterNameFor(section, studentId);
    const name = rosName || (idOk ? 'Student ' + studentId : 'Unidentified sheet');

    const rec = {
      id: Date.now(),
      ts: new Date().toISOString(),
      studentId,
      name,
      section,
      correct,
      total,
      percentage: pct,
      answers: result.detected,
      ambiguous: result.ambiguous || []
    };

    let duplicate = false;
    if (idOk) {
      const idx = state.records.findIndex((r) => r.section === section && r.studentId === studentId);
      if (idx >= 0) {
        duplicate = true;
        state.records.splice(idx, 1);
      }
    }
    state.records.push(rec);
    saveRecords();
    updateRecordsTable();
    onGradeSectionChange();
    if ($('analysis-section-select').value === section) App.renderAnalysis();

    const issues = [];
    if (!idOk) issues.push('ID unreadable — rename it in Students');
    if (result.ambiguous && result.ambiguous.length) issues.push('faint marks on Q' + result.ambiguous.slice(0, 4).join(', Q'));

    return {
      duplicate,
      toast: `${duplicate ? 'Updated' : 'Saved'}: ${name} — ${correct}/${total} (${fmtPct(pct)})` +
        (issues.length ? ' · ' + issues.join(' · ') : ''),
      note: issues.length ? issues.join(' · ') : null
    };
  }

  /* ------------------------------------------------------------------ *
   * Preview drawing
   * ------------------------------------------------------------------ */
  function drawPreview(result, cfg) {
    const preview = $('preview-canvas');
    const buffer = $('warp-buffer');
    const ctx = preview.getContext('2d');
    preview.width = 320;
    preview.height = 400;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(buffer, 0, 0, buffer.width, buffer.height, 0, 0, preview.width, preview.height);

    const scaleX = preview.width / buffer.width;
    const scaleY = preview.height / buffer.height;
    const key = (state.cameraMode === 'grade' && state.sections[state.activeSection])
      ? state.sections[state.activeSection].key : null;

    (result.idBubbles || []).forEach((b) => {
      if (!b.isDetected) return;
      ctx.beginPath();
      ctx.arc(b.x * scaleX, b.y * scaleY, Math.max(2, b.r * scaleX), 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    (result.bubbles || []).forEach((b) => {
      const x = b.x * scaleX, y = b.y * scaleY, r = Math.max(2.5, b.r * scaleX);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.stroke();
      if (b.isDetected) {
        let color = '#6366f1';
        if (key) color = (key[b.item] === b.label) ? '#34d399' : '#f87171';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });
  }

  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctxA = new AC();
      const osc = ctxA.createOscillator();
      const gain = ctxA.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctxA.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctxA.currentTime + 0.18);
      osc.connect(gain).connect(ctxA.destination);
      osc.start();
      osc.stop(ctxA.currentTime + 0.18);
      setTimeout(() => ctxA.close && ctxA.close(), 400);
    } catch (e) { /* audio unavailable */ }
  }

  /* ------------------------------------------------------------------ *
   * Records table
   * ------------------------------------------------------------------ */
  function sectionRecords(section) {
    return state.records.filter((r) => r.section === section);
  }

  function recordTime(r) {
    if (r.ts) {
      const d = new Date(r.ts);
      if (!isNaN(d)) {
        return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
    }
    return r.timestamp || '';
  }

  function updateRecordsTable() {
    const filter = $('records-filter').value;
    const term = ($('records-search').value || '').trim().toLowerCase();
    let rows = state.records.slice();
    if (filter) rows = rows.filter((r) => r.section === filter);
    if (term) rows = rows.filter((r) => (r.name || '').toLowerCase().includes(term) || (r.studentId || '').includes(term));

    rows.sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return (tb || b.id) - (ta || a.id);
    });

    const tbody = $('records-table-body');
    $('record-count').textContent = state.records.length ? '(' + state.records.length + ')' : '';
    $('records-empty').classList.toggle('hidden', rows.length !== 0);

    tbody.innerHTML = rows.map((rec) => {
      const onRoster = !!rosterNameFor(rec.section, rec.studentId);
      const pctNum = rec.percentage || 0;
      const pctClass = pctNum >= 75 ? 'text-emerald-400' : (pctNum >= 50 ? 'text-amber-300' : 'text-rose-400');
      return `
        <tr class="hover:bg-slate-800/40 border-b border-slate-800 cursor-pointer" onclick="App.openReport(${rec.id})">
          <td class="p-2 text-slate-500 whitespace-nowrap">${escapeHtml(recordTime(rec))}</td>
          <td class="p-2 font-mono text-indigo-300">${escapeHtml(rec.studentId === 'Unknown' ? '—' : rec.studentId)}</td>
          <td class="p-2 font-medium text-white">
            ${escapeHtml(rec.name)}
            ${onRoster ? '<i class="fa-solid fa-circle-check text-[9px] text-emerald-400 ml-1" title="Matched to roster"></i>' : ''}
            ${rec.answers && Object.values(rec.answers).some((v) => v === 'N/A') ? '<i class="fa-solid fa-circle-exclamation text-[9px] text-amber-400 ml-1" title="Has blank answers"></i>' : ''}
          </td>
          <td class="p-2 text-slate-300">${escapeHtml(rec.section)}</td>
          <td class="p-2 font-semibold text-indigo-300">${rec.correct}/${rec.total}</td>
          <td class="p-2 font-semibold ${pctClass}">${fmtPct(rec.percentage)}</td>
          <td class="p-2 text-right whitespace-nowrap">
            <button onclick="event.stopPropagation();App.openReport(${rec.id})" class="text-indigo-300 hover:text-indigo-200 mx-1" title="Open report"><i class="fa-solid fa-file-lines"></i></button>
            <button onclick="event.stopPropagation();App.deleteRecord(${rec.id})" class="text-rose-400 hover:text-rose-300 mx-1" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
          </td>
        </tr>`;
    }).join('');
  }

  App.editRecordName = function (id) {
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return;
    const name = prompt('Student name:', rec.name);
    if (name && name.trim()) {
      rec.name = name.trim();
      saveRecords();
      updateRecordsTable();
      if (state.reportId === id) App.openReport(id);
    }
  };

  App.deleteRecord = function (id) {
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return;
    if (!confirm(`Delete the result for ${rec.name}?`)) return;
    state.records = state.records.filter((r) => r.id !== id);
    saveRecords();
    updateRecordsTable();
    App.renderAnalysis();
    onGradeSectionChange();
    renderRoster();
  };

  App.clearSectionResults = function () {
    const section = $('records-filter').value || $('analysis-section-select').value;
    if (!section) { toast('Choose a section in the filter first.', 'warn'); return; }
    const count = sectionRecords(section).length;
    if (!count) { toast('That section has no results yet.', 'warn'); return; }
    if (!confirm(`Delete all ${count} scanned results for “${section}”?\n\nThe answer key and roster stay. This cannot be undone.`)) return;
    state.records = state.records.filter((r) => r.section !== section);
    saveRecords();
    updateRecordsTable();
    App.renderAnalysis();
    renderRoster();
    toast(`Deleted ${count} results for “${section}”.`, 'warn');
  };

  /* ------------------------------------------------------------------ *
   * Roster
   * ------------------------------------------------------------------ */
  function parseRosterLine(line) {
    let cleaned = line.replace(/\u00a0/g, ' ').trim();
    if (!cleaned) return null;
    cleaned = cleaned.replace(/^["']|["']$/g, '').trim();

    let parts = cleaned.split(/\s*[,;\t]\s*|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    let id = '';
    let name = '';

    const idIdx = parts.findIndex((p) => /^\d{4,12}$/.test(p.replace(/\s/g, '')));
    if (idIdx >= 0) {
      id = parts[idIdx].replace(/\D/g, '');
      name = parts.filter((_, i) => i !== idIdx).join(' ').trim();
    } else {
      const m = cleaned.match(/^(\d{4,12})[\s,;-]+(.+)$/);
      if (!m) return null;
      id = m[1];
      name = m[2].trim();
    }

    name = name.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
    if (!id || !name) return null;
    if (/^(student\s*name|name|section|id|student\s*id)$/i.test(name)) return null;
    return { id, name };
  }

  App.importRoster = function () {
    const section = $('roster-section').value;
    if (!section) { toast('Save an answer key for the section first.', 'warn'); return; }
    const text = $('roster-input').value;
    const lines = text.split(/\r?\n/);
    let added = 0, replaced = 0, skipped = 0;

    if (!state.rosters[section]) state.rosters[section] = {};
    const roster = state.rosters[section];

    lines.forEach((line) => {
      const parsed = parseRosterLine(line);
      if (!parsed) { if (line.trim()) skipped++; return; }
      if (roster[parsed.id]) replaced++; else added++;
      roster[parsed.id] = parsed.name;
    });

    if (!added && !replaced) {
      toast('No names found. Use one line per student, e.g. 1234567, Juan Dela Cruz', 'warn');
      return;
    }

    saveRosters();
    $('roster-input').value = '';
    renderRoster();
    updateRecordsTable();
    toast(`Roster saved: ${added} added${replaced ? ', ' + replaced + ' updated' : ''}${skipped ? ', ' + skipped + ' line(s) skipped' : ''}.`);
  };

  App.handleRosterFile = function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('roster-input').value = String(reader.result || '');
      App.importRoster();
      input.value = '';
    };
    reader.readAsText(file);
  };

  App.clearRoster = function () {
    const section = $('roster-section').value;
    if (!section || !state.rosters[section]) return;
    if (!confirm(`Remove all names from the roster for “${section}”? Results already scanned keep their names.`)) return;
    delete state.rosters[section];
    saveRosters();
    renderRoster();
    updateRecordsTable();
  };

  function renderRoster() {
    const section = $('roster-section').value;
    const roster = state.rosters[section] || {};
    const ids = Object.keys(roster).sort();
    $('roster-count').textContent = ids.length + (ids.length === 1 ? ' student' : ' students');

    $('roster-list').innerHTML = ids.length
      ? ids.map((id) => `
          <div class="flex items-center justify-between gap-2 border-b border-slate-800/70 py-1">
            <span class="font-mono text-indigo-300/90">${escapeHtml(id)}</span>
            <span class="flex-1 truncate">${escapeHtml(roster[id])}</span>
            <button onclick="App.removeRosterStudent('${escapeHtml(id)}')" class="text-slate-500 hover:text-rose-400" title="Remove"><i class="fa-solid fa-xmark"></i></button>
          </div>`).join('')
      : '<p class="text-slate-500 text-[11px] py-2">No roster yet for this section.</p>';

    const progress = $('roster-progress');
    if (!ids.length) { progress.textContent = ''; return; }

    const graded = new Set(sectionRecords(section).map((r) => r.studentId));
    const missing = ids.filter((id) => !graded.has(id));
    progress.innerHTML = missing.length
      ? `<i class="fa-solid fa-hourglass-half mr-1"></i>${ids.length - missing.length} of ${ids.length} scanned · not yet: ${missing.slice(0, 6).map((id) => escapeHtml(roster[id].split(' ')[0])).join(', ')}${missing.length > 6 ? ' +' + (missing.length - 6) + ' more' : ''}`
      : `<i class="fa-solid fa-circle-check mr-1"></i>All ${ids.length} students scanned.`;
  }

  App.removeRosterStudent = function (id) {
    const section = $('roster-section').value;
    if (!section || !state.rosters[section]) return;
    delete state.rosters[section][id];
    saveRosters();
    renderRoster();
  };

  /* ------------------------------------------------------------------ *
   * Analysis
   * ------------------------------------------------------------------ */
  function autoPickAnalysisSection() {
    const sel = $('analysis-section-select');
    if (sel.value) return;
    const withResults = Object.keys(state.sections).filter((n) => sectionRecords(n).length > 0).sort();
    if (withResults.length) sel.value = withResults[0];
  }

  function kr20(recs, key, itemCount) {
    const n = recs.length;
    if (n < 2) return null;
    const totals = recs.map((r) => r.correct);
    const v = variance(totals);
    if (v <= 0) return null;
    let sumPQ = 0;
    for (let i = 1; i <= itemCount; i++) {
      const p = recs.filter((r) => r.answers && r.answers[i] === key[i]).length / n;
      sumPQ += p * (1 - p);
    }
    const r = (itemCount / (itemCount - 1)) * (1 - sumPQ / v);
    return isFinite(r) ? clamp(r, -1, 1) : null;
  }

  function analyse(section) {
    const cfg = state.sections[section];
    const recs = sectionRecords(section);
    const n = recs.length;
    const key = cfg.key;
    const pcts = recs.map((r) => r.percentage);
    const passMark = clamp(parseInt($('pass-mark').value, 10) || 75, 1, 100);

    const totals = recs.map((r) => r.correct);
    const items = [];

    for (let i = 1; i <= cfg.itemCount; i++) {
      const answered = recs.filter((r) => r.answers && r.answers[i] !== undefined);
      const rights = answered.filter((r) => r.answers[i] === key[i]);
      const wrongs = answered.filter((r) => r.answers[i] !== key[i]);
      const p = answered.length ? rights.length / answered.length : 0;

      // Item-rest point-biserial correlation (discrimination).
      const restScore = (r) => r.correct - (r.answers[i] === key[i] ? 1 : 0);
      const restAll = answered.map(restScore);
      const sdRest = stddev(restAll);
      const meanR = avg(rights.map(restScore));
      const meanW = avg(wrongs.map(restScore));
      let disc = null;
      if (answered.length >= 5 && sdRest > 0 && wrongs.length) {
        disc = ((meanR - meanW) / sdRest) * Math.sqrt(p * (1 - p));
      }

      const counts = {};
      CHOICE_LETTERS.slice(0, cfg.choicesCount).forEach((c) => { counts[c] = 0; });
      let blanks = 0;
      answered.forEach((r) => {
        const a = r.answers[i];
        if (counts[a] !== undefined) counts[a]++;
        else blanks++;
      });

      let topWrong = null;
      Object.keys(counts).forEach((c) => {
        if (c === key[i]) return;
        if (!topWrong || counts[c] > topWrong.count) topWrong = { letter: c, count: counts[c] };
      });

      items.push({ item: i, key: key[i], p, correct: rights.length, total: answered.length, disc, counts, blanks, topWrong });
    }

    return {
      section, n, items,
      mean: avg(pcts),
      median: median(pcts),
      sd: stddev(pcts),
      min: n ? Math.min.apply(null, pcts) : 0,
      max: n ? Math.max.apply(null, pcts) : 0,
      passed: pcts.filter((x) => x >= passMark).length,
      passMark,
      kr20: kr20(recs, key, cfg.itemCount),
      itemCount: cfg.itemCount
    };
  }

  function verdictFor(item) {
    if (item.disc != null && item.disc < -0.05) return { cls: 'flag-bad', text: 'Check key' };
    if (item.p >= 0.95) return { cls: 'flag-muted', text: 'Too easy' };
    if (item.p < 0.30) return { cls: 'flag-bad', text: 'Very hard' };
    if (item.disc != null && item.disc < 0.10) return { cls: 'flag-warn', text: 'Weak item' };
    if (item.p < 0.50) return { cls: 'flag-warn', text: 'Challenging' };
    return { cls: 'flag-good', text: 'Good item' };
  }

  App.renderAnalysis = function () {
    const section = $('analysis-section-select').value;
    const recs = section ? sectionRecords(section) : [];
    const empty = $('analysis-empty');
    const body = $('analysis-body');

    if (!section || !state.sections[section] || !recs.length) {
      empty.classList.remove('hidden');
      body.classList.add('hidden');
      state.lastAnalysis = null;
      return;
    }
    empty.classList.add('hidden');
    body.classList.remove('hidden');

    const a = analyse(section);
    state.lastAnalysis = a;

    $('an-graded').textContent = a.n;
    $('an-mean').textContent = fmtPct(a.mean);
    $('an-median').textContent = fmtPct(a.median);
    $('an-sd').textContent = round(a.sd, 1).toString();
    $('an-pass').textContent = a.n ? `${a.passed}/${a.n} (${Math.round((a.passed / a.n) * 100)}%)` : '—';
    $('an-kr20').textContent = a.kr20 == null ? '—' : a.kr20.toFixed(2);
    $('an-kr20').title = 'KR-20 reliability: 0.70+ is acceptable for a classroom test, 0.80+ is strong.';

    // Score distribution
    const bands = [
      { label: '90–100%', min: 90, cls: '#34d399' },
      { label: '80–89%', min: 80, cls: '#60a5fa' },
      { label: '70–79%', min: 70, cls: '#818cf8' },
      { label: '60–69%', min: 60, cls: '#fbbf24' },
      { label: 'below 60%', min: -1, cls: '#fb7185' }
    ];
    const pcts = recs.map((r) => r.percentage);
    const maxCount = Math.max(1, ...bands.map((b) => pcts.filter((x) => x >= b.min).length));
    $('an-distribution').innerHTML = bands.map((b, idx) => {
      const upper = idx === 0 ? 1000 : bands[idx - 1].min;
      const count = pcts.filter((x) => x >= b.min && x < upper).length;
      return `<div class="flex items-center gap-2 text-[11px] text-slate-400">
        <span class="w-16 shrink-0">${b.label}</span>
        <span class="flex-1 h-2.5 rounded-full bg-slate-700/40 overflow-hidden">
          <span style="display:block;height:100%;width:${(count / maxCount) * 100}%;background:${b.cls}"></span>
        </span>
        <span class="w-8 text-right text-slate-300 font-semibold">${count}</span>
      </div>`;
    }).join('');

    // Insights
    const hard = a.items.filter((it) => it.p < 0.5).sort((x, y) => x.p - y.p).slice(0, 3);
    const miskeyed = a.items.filter((it) => it.disc != null && it.disc < -0.05);
    const blanks = a.items.filter((it) => it.blanks > 0);
    const notes = [];

    if (hard.length) {
      notes.push('<strong>Reteach first:</strong> ' + hard.map((it) => {
        const trap = it.topWrong && it.topWrong.count > 0
          ? ` (${Math.round((it.topWrong.count / Math.max(1, it.total)) * 100)}% chose ${it.topWrong.letter})`
          : '';
        return `Q${it.item} — ${Math.round(it.p * 100)}% correct${trap}`;
      }).join('; ') + '.');
    } else {
      notes.push('<strong>Every item was answered correctly by at least half the class.</strong> The test may have been on the easy side — check the distribution above.');
    }
    if (miskeyed.length) {
      notes.push('<strong>Possible mis-key:</strong> ' + miskeyed.map((it) => `Q${it.item}`).join(', ') + ' — stronger students chose differently, which usually means the key is wrong or the question is misleading.');
    }
    if (blanks.length) {
      notes.push('<strong>Blank answers:</strong> Q' + blanks.map((it) => it.item).join(', Q') + ' — some sheets have unmarked items. Worth a quick look.');
    }
    $('an-insights').innerHTML = notes.join('<br>');

    // Item table
    const open = state.openItems;
    $('analysis-table-body').innerHTML = a.items.map((it) => {
      const v = verdictFor(it);
      const diffWidth = Math.round(it.p * 100);
      const discText = it.disc == null ? '—' : it.disc.toFixed(2);
      const discCls = it.disc == null ? 'text-slate-500' : (it.disc >= 0.3 ? 'text-emerald-400' : (it.disc >= 0.1 ? 'text-amber-300' : 'text-rose-400'));
      const trap = it.topWrong && it.topWrong.count > 0
        ? `${it.topWrong.letter} <span class="text-slate-500">(${Math.round((it.topWrong.count / Math.max(1, it.total)) * 100)}%)</span>`
        : '<span class="text-slate-600">none</span>';
      const isOpen = open.has(it.item);

      const bars = CHOICE_LETTERS.slice(0, state.sections[section].choicesCount).map((c) => {
        const count = it.counts[c] || 0;
        const pct = it.total ? Math.round((count / it.total) * 100) : 0;
        const cls = c === it.key ? 'correct' : (it.topWrong && c === it.topWrong.letter ? 'trap' : '');
        return `<div class="dist-row">
          <span class="dist-letter">${c}${c === it.key ? '<i class="fa-solid fa-check text-[8px] text-emerald-400 ml-0.5"></i>' : ''}</span>
          <span class="dist-bar-wrap"><span class="dist-bar ${cls}" style="width:${pct}%"></span></span>
          <span class="w-16 text-right text-slate-400">${count} · ${pct}%</span>
        </div>`;
      }).join('');

      return `
        <tr class="item-row" onclick="App.toggleItemDetail(${it.item})">
          <td class="p-2 font-medium text-white">Q${it.item}</td>
          <td class="p-2 text-indigo-300 font-semibold">${escapeHtml(it.key || '—')}</td>
          <td class="p-2">${it.correct}/${it.total}</td>
          <td class="p-2">
            <div class="flex items-center gap-1.5">
              <span class="w-14 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
                <span style="display:block;height:100%;width:${diffWidth}%;background:${it.p >= 0.75 ? '#34d399' : it.p >= 0.5 ? '#818cf8' : '#fb7185'}"></span>
              </span>
              <span class="text-slate-400">${Math.round(it.p * 100)}%</span>
            </div>
          </td>
          <td class="p-2 font-mono ${discCls}">${discText}</td>
          <td class="p-2">${trap}</td>
          <td class="p-2"><span class="flag ${v.cls}">${v.text}</span></td>
          <td class="p-2 text-right text-slate-500"><i class="fa-solid fa-chevron-${isOpen ? 'up' : 'down'} text-[10px]"></i></td>
        </tr>
        <tr class="${isOpen ? '' : 'hidden'} detail-row" id="detail-${it.item}">
          <td colspan="8" class="p-3">
            <p class="text-[11px] text-slate-400 mb-2">Choice breakdown — <span class="text-emerald-400">green</span> is the keyed answer, <span class="text-amber-300">amber</span> is the most tempting wrong answer.${it.blanks ? ` ${it.blanks} blank.` : ''}</p>
            <div class="space-y-1.5 max-w-md">${bars}</div>
          </td>
        </tr>`;
    }).join('');

    onGradeSectionChange();
  };

  App.toggleItemDetail = function (item) {
    const row = $('detail-' + item);
    if (!row) return;
    if (state.openItems.has(item)) state.openItems.delete(item); else state.openItems.add(item);
    row.classList.toggle('hidden');
    const icon = row.previousElementSibling.querySelector('i.fa-chevron-down, i.fa-chevron-up');
    if (icon) icon.className = 'fa-solid text-[10px] ' + (state.openItems.has(item) ? 'fa-chevron-up' : 'fa-chevron-down');
  };

  /* ------------------------------------------------------------------ *
   * Sample data (for exploring the analysis screen)
   * ------------------------------------------------------------------ */
  App.loadDemoData = function () {
    const name = 'Sample — Science 7';
    if (state.sections[name]) { $('analysis-section-select').value = name; App.renderAnalysis(); return; }

    const itemCount = 20;
    const key = {};
    const letters = ['A', 'B', 'C', 'D'];
    for (let i = 1; i <= itemCount; i++) key[i] = letters[(i * 3 + 1) % 4];

    state.sections[name] = { itemCount, choicesCount: 4, key, updatedAt: new Date().toISOString() };

    const firstNames = ['Ana', 'Ben', 'Carla', 'Dante', 'Elena', 'Ferdie', 'Grace', 'Hector', 'Ivy', 'Joel', 'Karla', 'Lito',
      'Mara', 'Nico', 'Olive', 'Paolo', 'Queenie', 'Rico', 'Sofia', 'Tino', 'Ursula', 'Vince', 'Wendy', 'Yano'];
    const lastNames = ['Reyes', 'Cruz', 'Santos', 'Bautista', 'Garcia', 'Mendoza', 'Torres', 'Flores', 'Ramos', 'Aquino',
      'Castillo', 'Villanueva', 'Domingo', 'Salazar', 'Navarro', 'Padilla', 'Rosales', 'Tolentino', 'Uy', 'Valdez',
      'Zamora', 'Abad', 'Basilio', 'Cabrera'];

    state.rosters[name] = {};
    state.records = state.records.filter((r) => r.section !== name);

    firstNames.forEach((fn, idx) => {
      const id = String(1000001 + idx * 7);
      const full = fn + ' ' + lastNames[idx].trim();
      state.rosters[name][id] = full;

      const ability = 0.35 + (idx % 8) / 10;      // spread of abilities
      const answers = {};
      let correct = 0;
      for (let i = 1; i <= itemCount; i++) {
        const hard = [4, 9, 14, 17].includes(i) ? 0.35 : 0;   // items the class struggled with
        const chance = clamp(ability - hard, 0.05, 0.97);
        const right = Math.random() < chance;
        if (right) { answers[i] = key[i]; correct++; }
        else {
          const wrong = letters.filter((c) => c !== key[i]);
          answers[i] = wrong[Math.floor(Math.random() * wrong.length)];
        }
      }
      state.records.push(normalizeRecord({
        id: Date.now() + idx,
        ts: new Date(Date.now() - (24 - idx) * 60000).toISOString(),
        studentId: id,
        name: full,
        section: name,
        correct,
        total: itemCount,
        percentage: (correct / itemCount) * 100,
        answers
      }));
    });

    saveSections(); saveRecords(); saveRosters();
    refreshSectionDropdowns();
    $('analysis-section-select').value = name;
    $('records-filter').value = name;
    updateRecordsTable();
    renderRoster();
    App.renderAnalysis();
    toast('Sample class added (24 students). Delete it from Students when finished exploring.', 'warn');
  };

  /* ------------------------------------------------------------------ *
   * Reports
   * ------------------------------------------------------------------ */
  App.openReport = function (id) {
    const rec = state.records.find((r) => r.id === id);
    if (!rec) return;
    state.reportId = id;
    $('report-body').innerHTML = reportHTML(rec);
    $('report-modal').classList.remove('hidden');
    $('report-modal').classList.add('flex');
  };

  App.closeReport = function () {
    $('report-modal').classList.add('hidden');
    $('report-modal').classList.remove('flex');
    state.reportId = null;
  };

  function itemResult(rec, i) {
    const cfg = state.sections[rec.section];
    const keyAns = cfg && cfg.key ? cfg.key[i] : null;
    const given = rec.answers ? rec.answers[i] : null;
    if (!given || given === 'N/A' || given === '?') return { state: 'blank', given: '—', key: keyAns };
    if (given === keyAns) return { state: 'ok', given, key: keyAns };
    return { state: 'no', given, key: keyAns };
  }

  function reportHTML(rec) {
    const cfg = state.sections[rec.section];
    const total = rec.total || (cfg ? cfg.itemCount : 0);
    const pct = rec.percentage;
    const review = [];
    const cells = [];
    for (let i = 1; i <= total; i++) {
      const r = itemResult(rec, i);
      if (r.state !== 'ok') review.push({ item: i, given: r.given, key: r.key });
      cells.push(`<div class="answer-cell ${r.state}"><span class="text-slate-500">${i}</span><b>${escapeHtml(r.given)}</b></div>`);
    }
    const graded = state.records.filter((r) => r.section === rec.section);
    const pcts = graded.map((r) => r.percentage);
    const meanPct = avg(pcts);

    return `
      <div class="report-head">
        <h3 class="text-lg font-bold text-white">${escapeHtml(rec.name)}</h3>
        <p class="text-xs text-slate-400">
          ID ${escapeHtml(rec.studentId === 'Unknown' ? '—' : rec.studentId)} · ${escapeHtml(rec.section)} · ${escapeHtml(recordTime(rec))}
        </p>
      </div>
      <div class="grid grid-cols-3 gap-2 mb-4">
        <div class="stat-card"><p class="stat-label">Score</p><p class="stat-value">${rec.correct} / ${total}</p></div>
        <div class="stat-card"><p class="stat-label">Percentage</p><p class="stat-value text-emerald-300">${fmtPct(pct)}</p></div>
        <div class="stat-card"><p class="stat-label">Class mean</p><p class="stat-value">${graded.length > 1 ? fmtPct(meanPct) : '—'}</p></div>
      </div>
      ${graded.length > 1 ? `<p class="text-[11px] text-slate-400 mb-3">This student scored ${pct >= meanPct ? '<strong class="text-emerald-300">above</strong>' : '<strong class="text-amber-300">below</strong>'} the class average of ${fmtPct(meanPct)}.</p>` : ''}

      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Answer map</p>
      <div class="answer-grid mb-4">${cells.join('')}</div>

      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Items to review (${review.length})</p>
      ${review.length ? `
        <div class="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
          ${review.map((r) => `Q${r.item}: answered <strong class="text-rose-300">${escapeHtml(r.given)}</strong>, correct is <strong class="text-emerald-300">${escapeHtml(r.key)}</strong>`).join('<br>')}
        </div>` : '<p class="text-xs text-emerald-300">Perfect paper — every item correct.</p>'}

      <div class="mt-4 flex gap-2">
        <button onclick="App.editRecordName(${rec.id})" class="ghost-btn px-3 py-2 rounded-lg text-xs font-semibold text-slate-200"><i class="fa-solid fa-pen mr-1"></i>Rename student</button>
        <button onclick="App.printStudentReport()" class="aurora-btn px-3 py-2 rounded-lg text-xs font-semibold text-white"><i class="fa-solid fa-print mr-1"></i>Print report</button>
      </div>`;
  }

  App.printStudentReport = function () {
    const rec = state.records.find((r) => r.id === state.reportId);
    if (!rec) return;
    const total = rec.total || 0;
    const rows = [];
    for (let i = 1; i <= total; i++) {
      const r = itemResult(rec, i);
      rows.push(`<tr><td>Q${i}</td><td>${escapeHtml(r.given)}</td><td>${escapeHtml(r.key)}</td><td>${r.state === 'ok' ? '✓' : (r.state === 'blank' ? 'blank' : '✗')}</td></tr>`);
    }
    const cfg = state.sections[rec.section];
    const review = [];
    for (let i = 1; i <= total; i++) {
      const r = itemResult(rec, i);
      if (r.state !== 'ok') review.push(`Q${i} (answered ${r.given}, correct ${r.key})`);
    }

    $('print-area').innerHTML = `
      <h1>Student Report</h1>
      <p class="print-meta">${escapeHtml(rec.name)} · ID ${escapeHtml(rec.studentId === 'Unknown' ? '—' : rec.studentId)} · ${escapeHtml(rec.section)} · ${escapeHtml(recordTime(rec))}</p>
      <div class="print-box">
        <span class="print-score">${rec.correct}/${total}</span>
        <strong>${fmtPct(rec.percentage)}</strong>
        <p class="print-meta">${cfg ? cfg.itemCount + ' items · ' + cfg.choicesCount + ' choices' : ''}</p>
      </div>
      <h2>Answer sheet breakdown</h2>
      <table><thead><tr><th>Item</th><th>Answered</th><th>Correct answer</th><th>Result</th></tr></thead><tbody>${rows.join('')}</tbody></table>
      <h2>Items to review (${review.length})</h2>
      <p>${review.length ? review.join('; ') : 'None — every item correct.'}</p>
      <p class="print-meta" style="margin-top:8mm">Generated by OMR AutoGrader · ${new Date().toLocaleDateString()}</p>`;
    window.print();
  };

  App.printClassReport = function () {
    const a = state.lastAnalysis;
    if (!a) { toast('Pick a section with results first.', 'warn'); return; }
    const cfg = state.sections[a.section];
    const rows = a.items.map((it) => {
      const v = verdictFor(it);
      const trap = it.topWrong && it.topWrong.count ? `${it.topWrong.letter} (${Math.round((it.topWrong.count / Math.max(1, it.total)) * 100)}%)` : '—';
      return `<tr><td>Q${it.item}</td><td>${escapeHtml(it.key)}</td><td>${Math.round(it.p * 100)}%</td><td>${it.disc == null ? '—' : it.disc.toFixed(2)}</td><td>${trap}</td><td>${v.text}</td></tr>`;
    }).join('');

    const recs = sectionRecords(a.section).slice().sort((x, y) => y.percentage - x.percentage);
    const studentRows = recs.map((r, i) => {
      return `<tr><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.studentId === 'Unknown' ? '—' : r.studentId)}</td><td>${r.correct}/${r.total}</td><td>${fmtPct(r.percentage)}</td><td>${r.percentage >= a.passMark ? 'Passed' : 'Failed'}</td></tr>`;
    }).join('');

    $('print-area').innerHTML = `
      <h1>Class Report — ${escapeHtml(a.section)}</h1>
      <p class="print-meta">${a.itemCount} items · ${cfg.choicesCount} choices · ${a.n} students · generated ${new Date().toLocaleString()}</p>
      <div class="print-box">
        <strong>Mean ${fmtPct(a.mean)}</strong> · Median ${fmtPct(a.median)} · SD ${round(a.sd, 1)} ·
        Passed ${a.passed}/${a.n} at ${a.passMark}% · Range ${fmtPct(a.min)}–${fmtPct(a.max)} ·
        KR-20 ${a.kr20 == null ? '—' : a.kr20.toFixed(2)}
      </div>
      <h2>Item analysis</h2>
      <table><thead><tr><th>Item</th><th>Key</th><th>Correct</th><th>Discrimination</th><th>Top wrong</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="print-meta">Discrimination: 0.30+ good, 0.10–0.29 fair, below 0.10 review, negative usually means a mis-keyed item.</p>
      <div class="page-break"></div>
      <h1>Score sheet</h1>
      <p class="print-meta">${escapeHtml(a.section)} · pass mark ${a.passMark}%</p>
      <table><thead><tr><th>#</th><th>Student</th><th>ID</th><th>Score</th><th>%</th><th>Result</th></tr></thead><tbody>${studentRows}</tbody></table>`;
    window.print();
  };

  /* ------------------------------------------------------------------ *
   * Export / backup
   * ------------------------------------------------------------------ */
  App.exportCSV = function () {
    const filter = $('records-filter').value;
    const rows = filter ? state.records.filter((r) => r.section === filter) : state.records.slice();
    if (!rows.length) { toast('No results to export yet.', 'warn'); return; }

    const maxItems = Math.max(...rows.map((r) => r.total || 0), 0);
    const header = ['Scanned', 'Student ID', 'Student Name', 'Section', 'Correct', 'Total', 'Percentage'];
    for (let i = 1; i <= maxItems; i++) header.push('Q' + i);

    const lines = rows.map((r) => {
      const base = [recordTime(r), r.studentId === 'Unknown' ? '' : r.studentId, r.name, r.section, r.correct, r.total, round(r.percentage, 1)];
      for (let i = 1; i <= maxItems; i++) base.push((r.answers && r.answers[i] && r.answers[i] !== 'N/A') ? r.answers[i] : '');
      return base;
    });

    const csv = [header, ...lines].map((row) =>
      row.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadBlob('\ufeff' + csv,
      'omr-results-' + (filter ? filter.replace(/[^a-z0-9\-]+/gi, '_') + '-' : '') + new Date().toISOString().slice(0, 10) + '.csv',
      'text/csv;charset=utf-8');
    toast(`Exported ${rows.length} result${rows.length === 1 ? '' : 's'} to CSV.`);
  };

  App.backupAll = function () {
    if (!state.records.length && !Object.keys(state.sections).length) {
      toast('Nothing to back up yet.', 'warn');
      return;
    }
    const payload = {
      app: 'omr-autograder',
      type: 'backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      sections: state.sections,
      rosters: state.rosters,
      records: state.records,
      settings: state.settings
    };
    downloadBlob(JSON.stringify(payload),
      'omr-backup-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    toast('Backup saved — keep the file somewhere safe.');
  };

  App.restoreBackup = function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));

        if (data.type === 'omr-key' && data.section) {
          state.sections[data.section] = {
            itemCount: data.itemCount,
            choicesCount: data.choicesCount,
            key: data.key,
            updatedAt: new Date().toISOString()
          };
          saveSections();
          refreshSectionDropdowns();
          App.loadSectionIntoEditor(data.section);
          toast(`Answer key “${data.section}” imported.`);
          input.value = '';
          return;
        }

        if (!data.sections && !data.records) {
          toast('That file is not an OMR backup.', 'error');
          return;
        }
        const counts = `${Object.keys(data.sections || {}).length} keys, ${(data.records || []).length} results`;
        if (!confirm(`Restore this backup?\n\nIt contains ${counts}. This replaces the data currently in this browser.`)) return;

        state.sections = data.sections || {};
        state.rosters = data.rosters || {};
        state.records = (data.records || []).map(normalizeRecord);
        state.settings = Object.assign({ passMark: 75 }, data.settings || {});
        $('pass-mark').value = state.settings.passMark;
        saveSections(); saveRecords(); saveRosters(); saveSettings();
        refreshSectionDropdowns();
        updateRecordsTable();
        App.renderAnalysis();
        toast(`Restored ${counts}.`);
      } catch (e) {
        toast('Could not read that file: ' + e.message, 'error');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  };

  /* ------------------------------------------------------------------ *
   * Offline / PWA
   * ------------------------------------------------------------------ */
  function updateNetworkBadge() {
    const label = $('offline-label');
    const btn = $('offline-btn');
    if (navigator.onLine) {
      label.textContent = 'Online';
      btn.title = 'Tap to save the app for offline use';
      btn.className = 'ghost-btn px-2 py-1 rounded text-[11px] text-slate-300';
    } else {
      label.textContent = 'Offline';
      btn.title = 'Working offline — everything is stored on this device';
      btn.className = 'ghost-btn px-2 py-1 rounded text-[11px] text-emerald-300';
    }
  }

  App.prepareOffline = async function () {
    if (!('serviceWorker' in navigator)) {
      toast('This browser cannot save the app offline. Use Chrome, Edge or Safari over http(s).', 'warn');
      return;
    }
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ]);
      if (!reg || !reg.active) { toast('Offline storage is not ready yet — try again in a moment.', 'warn'); return; }
      toast('Saving the reader and interface for offline use…');
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (e.data && e.data.ok) toast('Saved — the app now opens without internet.');
        else toast('Some files could not be saved. Open the app once while online, then tap again.', 'warn');
      };
      reg.active.postMessage({ type: 'PRECACHE' }, [channel.port2]);
    } catch (e) {
      toast('Offline saving is unavailable: ' + e.message, 'error');
    }
  };

  App.installPwa = async function () {
    if (!state.deferredInstall) {
      toast('Use your browser menu → “Install app” or “Add to Home Screen”.', 'warn');
      return;
    }
    state.deferredInstall.prompt();
    const choice = await state.deferredInstall.userChoice;
    if (choice && choice.outcome === 'accepted') toast('Installed — open it from your home screen anytime.');
    state.deferredInstall = null;
    $('install-btn').classList.add('hidden');
  };

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((e) => {
        console.warn('Service worker registration failed', e);
      });
    });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstall = e;
      $('install-btn').classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => $('install-btn').classList.add('hidden'));
  }

  /* ------------------------------------------------------------------ *
   * Modals / misc
   * ------------------------------------------------------------------ */
  App.openHelp = function () { $('help-modal').classList.remove('hidden'); $('help-modal').classList.add('flex'); };
  App.closeHelp = function () { $('help-modal').classList.add('hidden'); $('help-modal').classList.remove('flex'); };

  App.onGradeSectionChange = onGradeSectionChange;

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  function bindEvents() {
    $('photo-input').addEventListener('change', (e) => handlePhoto(e.target.files && e.target.files[0]));

    ['gen-item-count', 'key-item-count'].forEach((id) => {
      const el = $(id);
      if (el) el.max = String(MAX_ITEMS);
    });

    $('key-item-count').addEventListener('input', updateKeySummary);
    $('key-choices-count').addEventListener('change', updateKeySummary);
    $('pass-mark').addEventListener('change', () => {
      state.settings.passMark = clamp(parseInt($('pass-mark').value, 10) || 75, 1, 100);
      saveSettings();
    });

    // Close modals with Escape or by clicking the backdrop.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('camera-modal').classList.contains('hidden')) App.closeCameraModal();
      else if (!$('report-modal').classList.contains('hidden')) App.closeReport();
      else if (!$('help-modal').classList.contains('hidden')) App.closeHelp();
    });
    ['camera-modal', 'report-modal', 'help-modal'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        if (e.target.id !== id) return;
        if (id === 'camera-modal') App.closeCameraModal();
        if (id === 'report-modal') App.closeReport();
        if (id === 'help-modal') App.closeHelp();
      });
    });

    window.addEventListener('online', updateNetworkBadge);
    window.addEventListener('offline', updateNetworkBadge);

    const printClear = () => { $('print-area').innerHTML = ''; };
    window.addEventListener('afterprint', printClear);

    // Keep records readable if another tab changes them.
    window.addEventListener('storage', (e) => {
      if (e.key === KEYS.records || e.key === KEYS.sections) {
        loadState();
        refreshSectionDropdowns();
        updateRecordsTable();
        App.renderAnalysis();
      }
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadState();
    bindEvents();
    App.buildKeyEditor();
    refreshSectionDropdowns();
    updateRecordsTable();
    renderRoster();
    updateNetworkBadge();
    registerServiceWorker();
    initEngine();
  });

  window.App = App;
})();
