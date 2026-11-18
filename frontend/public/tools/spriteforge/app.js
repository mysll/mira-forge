(() => {
  'use strict';

  const MAX_FRAMES = 1000;
  const MAX_PAGES = 48;
  const MAX_CANVAS = 8192;
  const MAX_ATLAS_NAME = 64;
  const SEQ_COLORS = ['#ff9d4d', '#68e6cd', '#8eb6ff', '#e08bff', '#ffd166', '#ff7a9c', '#9ee37d', '#b9a2ff'];
  const FPS_CANDIDATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  // 抠像容差按欧氏 RGB 距离算（0–441）。实测本机的绿幕素材：背景噪声在 24 以内就干净了，
  // 主体边缘从 ~32 开始，所以滑块上限定 96 —— 够吃掉软边，又不至于把整条色域摊平、没法微调。
  const MAX_KEY_TOLERANCE = 96;

  const state = {
    videoFile: null,
    videoUrl: null,
    videoReady: false,
    duration: 0,
    videoWidth: 0,
    videoHeight: 0,
    frames: [],
    track: [],
    current: -1,
    previewFps: 24,
    playing: false,
    playRaf: 0,
    lastTs: 0,
    playAcc: 0,
    extractToken: 0,
    extracting: false,
    detecting: false,
    previewRaf: 0,
    dragIndex: -1,
    dragTarget: null,
    bgMode: 'checker',
    key: {
      enabled: false,
      color: '#00B140',
      tolerance: 48,
      feather: 24
    },
    atlas: {
      name: '',
      config: null,
      pages: [],
      sequences: [],
      nextCell: 0
    },
    busy: {
      active: false,
      cancel: null
    }
  };

  const icons = {
    play: '<svg class="icon"><use href="#i-play"/></svg>',
    pause: '<svg class="icon"><use href="#i-pause"/></svg>',
    check: '<svg class="icon"><use href="#i-check"/></svg>',
    info: '<svg class="icon"><use href="#i-info"/></svg>',
    warn: '<svg class="icon"><use href="#i-info"/></svg>',
    error: '<svg class="icon"><use href="#i-x"/></svg>'
  };

  let els = {};
  let dragDepth = 0;
  // MiraForge: 连续导入两支视频时，晚到的旧一次载入不能覆盖新的那支。
  let videoLoadToken = 0;
  let crcTable = null;
  const zipEncoder = new TextEncoder();
  const zipDecoder = new TextDecoder('utf-8');

  /* ---- MiraForge 宿主桥接 ----------------------------------------------
     宿主页面在 window 上挂 window.MiraForgeToolBridge：
       chooseSource(kind, anchor) -> Promise<{ action: 'local' } | { action: 'asset', file } | null>
       saveAsset(blob, name)      -> Promise<unknown>
     没有宿主时，导入仍走原版的文件选择框，保存仍走浏览器下载。
     ---------------------------------------------------------------------- */
  const hostListeners = [];

  function onGlobal(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    hostListeners.push([target, type, handler, options]);
  }

  function readBridge() {
    return (typeof window !== 'undefined' && window.MiraForgeToolBridge) || null;
  }

  // MiraForge: 宿主页面在注入标记之后调用 window.MiraSpriteForge.boot()，那时整个 IIFE 已经执行完，
  // 后面的 let 声明都已初始化；单独打开这个文件时仍走 DOMContentLoaded。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  }

  function init() {
    cacheElements();
    loadPrefs();
    syncAtlasNameUI();
    bindEvents();
    syncVideoUI();
    syncChromaControls();
    syncGridReadout();
    syncSettingsLock();
    updateFrameEstimate();
    renderFrameGrid();
    renderTrack();
    syncPreviewUI();
    drawPreview();
    renderAtlasPanel();
    syncAtlasDependentUI();
    setPlayIcon(false);
    activateTab('settings');
    setupResizeObserver();
  }

  function cacheElements() {
    const ids = [
      'videoInput', 'atlasInput', 'helpBtn', 'importAtlasBtn', 'importVideoBtnTop', 'exportBtn', 'exportBadge',
      'statusDot', 'projectSummary',
      'videoBadge', 'sourceScroll', 'videoEmpty', 'importVideoBtn', 'videoLoaded', 'video', 'videoRes',
      'videoName', 'videoMeta', 'resetRangeBtn', 'fpsInput', 'detectFpsBtn', 'frameEstimate', 'startTimeInput',
      'endTimeInput', 'extractBtn', 'extractProgress', 'extractLabel', 'cancelExtractBtn', 'extractBar',
      'extractSub', 'frameCount', 'selectAllBtn', 'clearSelectionBtn', 'frameGrid', 'frameEmpty', 'previewMeta',
      'bgToggleBtn', 'previewStage', 'previewCanvas', 'previewEmpty', 'stageBadges', 'stageSizeBadge',
      'stageAlphaBadge', 'scrubber', 'firstBtn', 'prevBtn', 'playBtn', 'nextBtn', 'lastBtn', 'timecode',
      'previewFpsInput', 'loopToggle', 'trackBadge', 'sequenceName', 'addToAtlasBtn', 'clearTrackBtn', 'timeline',
      'settingsLock', 'atlasWidthInput', 'atlasHeightInput', 'rowsInput', 'colsInput', 'miniGrid', 'cellSizeText',
      'capacityText', 'chromaToggle', 'keyColorInput', 'keyColorText', 'sampleColorBtn', 'toleranceInput',
      'toleranceValue', 'featherInput', 'featherValue', 'appendHintBtn', 'atlasEmpty', 'atlasContent',
      'atlasNameInput', 'atlasNamePreview',
      'statPages', 'statUsed', 'statCapacity', 'pageHint', 'pageList', 'sequenceHint', 'sequenceList',
      'exportFromAtlasBtn', 'clearAtlasBtn', 'atlasTabBadge', 'settingsPane', 'atlasPane', 'dropOverlay',
      'modalRoot', 'toastRoot', 'progressOverlay', 'busyTitle', 'busySub', 'busyBar', 'busyCancelBtn',
      'importAtlasBtn2', 'framePeek', 'framePeekImage', 'framePeekIndex', 'framePeekTime', 'framePeekSize'
    ];
    els = {};
    for (const id of ids) els[id] = document.getElementById(id);
  }

  const INPUT_BY_KIND = { video: 'videoInput', atlas: 'atlasInput' };

  function pickLocal(kind) {
    if (kind === 'video') return triggerVideoInput();
    if (state.extracting) return showToast('请先等待当前提取结束，或取消提取。', 'warn');
    if (state.busy.active) return;
    els.atlasInput.click();
  }

  function injectFile(kind, file) {
    const id = INPUT_BY_KIND[kind];
    const input = (id && (els[id] || document.getElementById(id))) || null;
    if (!input || !file) return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function requestImport(kind, anchor) {
    const bridge = readBridge();
    if (!bridge || typeof bridge.chooseSource !== 'function') return pickLocal(kind);
    let choice = null;
    try {
      choice = await bridge.chooseSource(kind, anchor || null);
    } catch (error) {
      console.error(error);
      return;
    }
    if (!choice) return;
    if (choice.action === 'local') return pickLocal(kind);
    if (choice.action === 'asset' && choice.file) injectFile(kind, choice.file);
  }

  function bindEvents() {
    // MiraForge: 四个导入入口都先问「本机还是资产」，没有宿主时自动回落到本机文件框。
    [['importVideoBtnTop', 'video'], ['importVideoBtn', 'video'], ['importAtlasBtn', 'atlas'], ['importAtlasBtn2', 'atlas']]
      .forEach(([id, kind]) => els[id].addEventListener('click', (event) => requestImport(kind, event.currentTarget)));
    els.videoInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) loadVideoFile(file);
    });

    els.atlasInput.addEventListener('change', (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length) handleAtlasFiles(files);
    });

    els.helpBtn.addEventListener('click', openHelpModal);
    els.exportBtn.addEventListener('click', openExportModal);
    els.exportFromAtlasBtn.addEventListener('click', openExportModal);
    els.atlasNameInput.addEventListener('input', onAtlasNameInput);
    els.atlasNameInput.addEventListener('blur', onAtlasNameBlur);

    els.extractBtn.addEventListener('click', extractFrames);
    els.cancelExtractBtn.addEventListener('click', cancelExtraction);
    els.detectFpsBtn.addEventListener('click', detectVideoFps);
    els.resetRangeBtn.addEventListener('click', resetRange);
    els.fpsInput.addEventListener('input', updateFrameEstimate);
    els.startTimeInput.addEventListener('input', updateFrameEstimate);
    els.endTimeInput.addEventListener('input', updateFrameEstimate);

    els.frameGrid.addEventListener('click', (event) => {
      const card = event.target.closest('.frame-card');
      if (card) toggleFrame(Number(card.dataset.index));
    });
    els.frameGrid.addEventListener('pointermove', onFrameGridPointerMove);
    els.frameGrid.addEventListener('pointerleave', onFrameGridPointerLeave);
    els.frameGrid.addEventListener('focusin', onFrameGridFocusIn);
    els.frameGrid.addEventListener('focusout', onFrameGridFocusOut);
    els.selectAllBtn.addEventListener('click', selectAllFrames);
    els.clearSelectionBtn.addEventListener('click', () => clearTrack(true));

    els.playBtn.addEventListener('click', togglePlayback);
    els.firstBtn.addEventListener('click', () => { stopPlayback(); setCurrent(0, true); });
    els.prevBtn.addEventListener('click', () => { stopPlayback(); stepFrame(-1); });
    els.nextBtn.addEventListener('click', () => { stopPlayback(); stepFrame(1); });
    els.lastBtn.addEventListener('click', () => { stopPlayback(); setCurrent(state.track.length - 1, true); });
    els.scrubber.addEventListener('input', () => {
      stopPlayback();
      setCurrent(Number(els.scrubber.value), false);
    });
    els.loopToggle.addEventListener('change', () => {
      if (state.playing) {
        state.lastTs = performance.now();
        state.playAcc = 0;
      }
    });
    els.previewFpsInput.addEventListener('input', () => {
      const value = clamp(parseFloat(els.previewFpsInput.value) || 24, 1, 60);
      state.previewFps = value;
      if (state.playing) {
        state.lastTs = performance.now();
        state.playAcc = 0;
      }
      syncPreviewUI();
    });
    els.previewFpsInput.addEventListener('blur', () => {
      els.previewFpsInput.value = state.previewFps;
      savePrefs();
    });
    els.bgToggleBtn.addEventListener('click', () => {
      state.bgMode = state.bgMode === 'checker' ? 'dark' : 'checker';
      syncPreviewUI();
      drawPreview();
    });

    els.timeline.addEventListener('click', onTimelineClick);
    els.timeline.addEventListener('dragstart', onClipDragStart);
    els.timeline.addEventListener('dragover', onClipDragOver);
    els.timeline.addEventListener('dragleave', onClipDragLeave);
    els.timeline.addEventListener('drop', onClipDrop);
    els.timeline.addEventListener('dragend', clearDragState);

    els.addToAtlasBtn.addEventListener('click', appendTrackToAtlas);
    els.appendHintBtn.addEventListener('click', appendTrackToAtlas);
    els.clearTrackBtn.addEventListener('click', () => clearTrack(true));

    document.querySelectorAll('.side-tab').forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });

    els.atlasWidthInput.addEventListener('input', onSettingsChanged);
    els.atlasHeightInput.addEventListener('input', onSettingsChanged);
    els.rowsInput.addEventListener('input', onSettingsChanged);
    els.colsInput.addEventListener('input', onSettingsChanged);
    [els.atlasWidthInput, els.atlasHeightInput, els.rowsInput, els.colsInput].forEach((input) => {
      input.addEventListener('blur', normalizeSettingsInputs);
    });
    document.querySelectorAll('.preset-btn').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.atlas.pages.length) return;
        const size = Number(button.dataset.size);
        els.atlasWidthInput.value = size;
        els.atlasHeightInput.value = size;
        document.querySelectorAll('.preset-btn').forEach((item) => item.classList.toggle('active', item === button));
        syncGridReadout();
        savePrefs();
      });
    });

    els.chromaToggle.addEventListener('change', () => {
      state.key.enabled = els.chromaToggle.checked;
      invalidateKeyCache();
      syncChromaControls();
      syncPreviewUI();
      schedulePreviewDraw();
      savePrefs();
    });
    els.keyColorInput.addEventListener('input', () => {
      state.key.color = normalizeHex(els.keyColorInput.value) || state.key.color;
      els.keyColorText.value = state.key.color;
      onKeySettingsChanged();
    });
    els.keyColorText.addEventListener('input', () => {
      const hex = normalizeHex(els.keyColorText.value);
      if (hex) {
        state.key.color = hex;
        els.keyColorInput.value = hex;
        onKeySettingsChanged();
      }
    });
    els.keyColorText.addEventListener('blur', () => {
      els.keyColorText.value = state.key.color;
    });
    els.toleranceInput.addEventListener('input', () => {
      state.key.tolerance = clamp(Number(els.toleranceInput.value) || 0, 0, MAX_KEY_TOLERANCE);
      els.toleranceValue.value = state.key.tolerance;
      onKeySettingsChanged();
    });
    els.featherInput.addEventListener('input', () => {
      state.key.feather = clamp(Number(els.featherInput.value) || 0, 0, 120);
      els.featherValue.value = state.key.feather;
      onKeySettingsChanged();
    });
    els.sampleColorBtn.addEventListener('click', sampleBackgroundColor);

    els.pageList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-page]');
      if (item) openPageModal(Number(item.dataset.page));
    });
    els.sequenceList.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-remove-seq]');
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      removeSequenceAt(Number(trigger.dataset.removeSeq));
    });
    els.clearAtlasBtn.addEventListener('click', clearAtlas);

    els.busyCancelBtn.addEventListener('click', () => {
      const cancel = state.busy.cancel;
      state.busy.cancel = null;
      els.busyCancelBtn.disabled = true;
      if (cancel) cancel();
    });

    onGlobal(document, 'keydown', onGlobalKeyDown);
    onGlobal(document, 'visibilitychange', () => {
      if (document.hidden) stopPlayback();
    });
    onGlobal(window, 'resize', schedulePreviewDraw);
    onGlobal(window, 'resize', () => hideFramePeek(true));
    onGlobal(window, 'scroll', () => hideFramePeek(true), true);
    onGlobal(window, 'keydown', (event) => {
      if (event.key === 'Escape') hideFramePeek(true);
    });

    onGlobal(window, 'dragenter', onWindowDragEnter);
    onGlobal(window, 'dragover', onWindowDragOver);
    onGlobal(window, 'dragleave', onWindowDragLeave);
    onGlobal(window, 'drop', onWindowDrop);
  }

  function setupResizeObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => schedulePreviewDraw());
    observer.observe(els.previewStage);
  }

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  const $ = (selector, root = document) => root.querySelector(selector);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readInt(input, min, max, fallback) {
    const value = parseInt(input.value, 10);
    if (!Number.isFinite(value)) return fallback;
    return clamp(value, min, max);
  }

  function readNumber(input, fallback) {
    const value = parseFloat(input.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function pad3(value) {
    return String(value).padStart(3, '0');
  }

  function formatClock(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const secs = value - minutes * 60;
    return `${pad2(minutes)}:${secs.toFixed(2).padStart(5, '0')}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeHex(value) {
    let raw = String(value || '').trim();
    if (!raw.startsWith('#')) raw = `#${raw}`;
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      raw = `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    }
    if (!/^#[0-9a-f]{6}$/i.test(raw)) return null;
    return raw.toUpperCase();
  }

  function normalizeAtlasName(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_ATLAS_NAME);
  }

  function currentAtlasName() {
    return normalizeAtlasName(state.atlas.name);
  }

  function atlasFileStem(name) {
    const source = normalizeAtlasName(name == null ? state.atlas.name : name);
    let stem = source
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^[. ]+|[. ]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!stem) stem = 'atlas';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `atlas_${stem}`;
    return stem;
  }

  function syncAtlasNamePreview() {
    const stem = atlasFileStem();
    const named = Boolean(currentAtlasName());
    els.atlasNamePreview.textContent = named
      ? `导出：${stem}_01.png · ${stem}.json`
      : '未命名 · 默认导出 atlas_01.png · atlas.json';
    els.atlasNamePreview.title = named
      ? `ZIP：${stem}_时间戳.zip\n页面：${stem}_01.png …\nJSON：${stem}.json`
      : '填写名称后，PNG、JSON 与 ZIP 会使用该名称；留空时沿用 atlas_01.png / atlas.json。';
    document.title = named ? `${currentAtlasName()} · 序列帧工坊` : '序列帧工坊 · SpriteForge';
  }

  function syncAtlasNameUI() {
    els.atlasNameInput.value = currentAtlasName();
    syncAtlasNamePreview();
  }

  function onAtlasNameInput() {
    state.atlas.name = els.atlasNameInput.value.slice(0, MAX_ATLAS_NAME);
    syncAtlasNamePreview();
    savePrefs();
  }

  function onAtlasNameBlur() {
    const normalized = normalizeAtlasName(els.atlasNameInput.value);
    state.atlas.name = normalized;
    if (els.atlasNameInput.value !== normalized) els.atlasNameInput.value = normalized;
    syncAtlasNamePreview();
    savePrefs();
  }

  function hexToRgb(hex) {
    const normalized = normalizeHex(hex) || '#000000';
    return [
      parseInt(normalized.slice(1, 3), 16),
      parseInt(normalized.slice(3, 5), 16),
      parseInt(normalized.slice(5, 7), 16)
    ];
  }

  function rgbToHex(r, g, b) {
    const toHex = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function timestampForName() {
    const date = new Date();
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  }

  function showToast(message, type = 'ok', duration = 3000) {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.innerHTML = `${icons[type] || icons.check}<span></span>`;
    node.querySelector('span').textContent = message;
    while (els.toastRoot.children.length >= 3) {
      els.toastRoot.firstElementChild.remove();
    }
    els.toastRoot.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 220);
    }, duration);
  }

  function savePrefs() {
    try {
      localStorage.setItem('spriteforge.prefs.v1', JSON.stringify({
        width: els.atlasWidthInput.value,
        height: els.atlasHeightInput.value,
        rows: els.rowsInput.value,
        cols: els.colsInput.value,
        previewFps: state.previewFps,
        key: state.key,
        atlasName: state.atlas.name
      }));
    } catch (error) {
      /* localStorage can be unavailable in private / file contexts. */
    }
  }

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem('spriteforge.prefs.v1') || 'null');
      if (!prefs) return;
      if (prefs.width) els.atlasWidthInput.value = prefs.width;
      if (prefs.height) els.atlasHeightInput.value = prefs.height;
      if (prefs.rows) els.rowsInput.value = prefs.rows;
      if (prefs.cols) els.colsInput.value = prefs.cols;
      if (Number.isFinite(Number(prefs.previewFps))) state.previewFps = clamp(Number(prefs.previewFps), 1, 60);
      if (prefs.key) {
        state.key.enabled = Boolean(prefs.key.enabled);
        state.key.color = normalizeHex(prefs.key.color) || state.key.color;
        state.key.tolerance = clamp(Number(prefs.key.tolerance) || 48, 0, MAX_KEY_TOLERANCE);
        state.key.feather = clamp(Number(prefs.key.feather) || 24, 0, 120);
      }
      if (typeof prefs.atlasName === 'string') state.atlas.name = normalizeAtlasName(prefs.atlasName);
    } catch (error) {
      /* Ignore malformed preferences. */
    }
    els.previewFpsInput.value = state.previewFps;
    els.chromaToggle.checked = state.key.enabled;
    els.keyColorInput.value = state.key.color;
    els.keyColorText.value = state.key.color;
    els.toleranceInput.value = state.key.tolerance;
    els.toleranceValue.value = state.key.tolerance;
    els.featherInput.value = state.key.feather;
    els.featherValue.value = state.key.feather;
  }

  /* ------------------------------------------------------------------ */
  /* Video import and frame extraction                                   */
  /* ------------------------------------------------------------------ */

  function triggerVideoInput() {
    if (state.extracting) {
      showToast('请先等待当前提取结束，或取消提取。', 'warn');
      return;
    }
    if (state.busy.active) return;
    els.videoInput.click();
  }

  function isVideoFile(file) {
    return Boolean(file) && (String(file.type).startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|ogg)$/i.test(file.name));
  }

  async function loadVideoFile(file) {
    if (state.extracting) {
      showToast('请先等待当前提取结束，或取消提取。', 'warn');
      return;
    }
    if (state.busy.active) return;
    if (!isVideoFile(file)) {
      showToast('请选择视频文件（MP4 / WebM / MOV）。', 'error');
      return;
    }

    stopPlayback();
    const token = ++videoLoadToken;
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'auto';
    probe.playsInline = true;
    probe.src = url;

    try {
      await waitForVideoMetadata(probe);
      if (token !== videoLoadToken) {
        URL.revokeObjectURL(url);
        return;
      }
      if (!probe.videoWidth || !probe.videoHeight || !Number.isFinite(probe.duration)) {
        throw new Error('视频没有可用的画面或时长信息。');
      }

      const oldUrl = state.videoUrl;
      try {
        await attachVideoSource(els.video, url);
      } catch (error) {
        // Restore the previous clip so an already extracted frame list stays playable.
        if (oldUrl) {
          attachVideoSource(els.video, oldUrl).catch(() => {});
        }
        throw error;
      }
      if (oldUrl) URL.revokeObjectURL(oldUrl);

      state.videoFile = file;
      state.videoUrl = url;
      state.videoReady = true;
      state.duration = probe.duration;
      state.videoWidth = probe.videoWidth;
      state.videoHeight = probe.videoHeight;
      state.frames = [];
      state.track = [];
      state.current = -1;
      state.extractToken++;
      invalidateKeyCache();

      els.videoLoaded.hidden = false;
      els.videoEmpty.hidden = true;
      els.videoName.textContent = file.name;
      els.videoRes.textContent = `${state.videoWidth} × ${state.videoHeight}`;
      els.videoMeta.textContent = `${formatBytes(file.size)}  ·  ${state.duration.toFixed(2)} s`;
      els.videoBadge.textContent = '已载入';
      els.videoBadge.className = 'chip chip-live';
      els.startTimeInput.value = '0';
      els.endTimeInput.value = state.duration.toFixed(2);
      els.video.currentTime = Math.min(0.04, state.duration / 2);

      if (!state.atlas.sequences.length) els.sequenceName.value = '序列 1';
      renderFrameGrid();
      renderTrack();
      syncPreviewUI();
      syncVideoUI();
      updateFrameEstimate();
      syncAtlasDependentUI();
      drawPreview();

      try { await seekVideo(els.video, Math.min(0.04, state.duration / 2)); } catch (error) { /* Poster is optional. */ }
      showToast(`已导入「${file.name}」`, 'ok');
    } catch (error) {
      URL.revokeObjectURL(url);
      console.error(error);
      showToast(`无法读取视频：${error.message || '浏览器不支持该编码'}`, 'error', 4500);
    } finally {
      probe.removeAttribute('src');
      try { probe.load(); } catch (error) { /* noop */ }
    }
  }

  function videoErrorMessage(video) {
    const code = video.error ? video.error.code : 0;
    const messages = {
      1: '视频加载被中止。',
      2: '网络或文件读取错误。',
      3: '视频解码失败。',
      4: '浏览器不支持该视频编码。'
    };
    return messages[code] || '视频解码失败。';
  }

  function waitForVideoMetadata(video) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('视频加载超时。')), 20000);
      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      }
      function finish(error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }
      function onLoaded() {
        if (video.videoWidth && video.videoHeight) finish();
        else finish(new Error('未能读取视频尺寸。'));
      }
      function onError() {
        finish(new Error(videoErrorMessage(video)));
      }
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      if (video.readyState >= 1 && video.videoWidth) {
        setTimeout(() => finish(), 0);
      } else {
        try { video.load(); } catch (error) { finish(error); }
      }
    });
  }

  function attachVideoSource(video, url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('视频加载超时。')), 20000);
      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      }
      function finish(error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }
      function onLoaded() {
        if (video.videoWidth && video.videoHeight) finish();
        else finish(new Error('未能读取视频尺寸。'));
      }
      function onError() {
        finish(new Error(videoErrorMessage(video)));
      }

      // Listen before assigning src. A previous clip may still be READY, and its
      // metadata must never be mistaken for the new clip's metadata.
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
      video.src = url;
      try { video.load(); } catch (error) { finish(error); }
    });
  }

  function seekVideo(video, time) {
    return new Promise((resolve) => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const target = clamp(Number(time) || 0, 0, Math.max(0, duration - 0.001));
      let settled = false;
      let frameCallback = 0;
      let frameTimer = 0;

      function cleanup() {
        clearTimeout(timeout);
        clearTimeout(frameTimer);
        video.removeEventListener('seeked', onSeeked);
        if (frameCallback && video.cancelVideoFrameCallback) {
          try { video.cancelVideoFrameCallback(frameCallback); } catch (error) { /* noop */ }
        }
      }
      function finish() {
        if (settled) return;
        settled = true;
        cleanup();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }
      function onSeeked() {
        if ('requestVideoFrameCallback' in video) {
          try {
            frameCallback = video.requestVideoFrameCallback(finish);
            frameTimer = setTimeout(finish, 90);
          } catch (error) {
            finish();
          }
        } else {
          finish();
        }
      }
      const timeout = setTimeout(finish, 5000);
      video.addEventListener('seeked', onSeeked, { once: true });
      try {
        if (Math.abs(video.currentTime - target) < 0.0002 && video.readyState >= 2) {
          setTimeout(finish, 30);
        } else {
          video.currentTime = target;
        }
      } catch (error) {
        finish();
      }
    });
  }

  function resetRange() {
    if (!state.videoReady) return;
    els.startTimeInput.value = '0';
    els.endTimeInput.value = state.duration.toFixed(2);
    updateFrameEstimate();
  }

  function updateFrameEstimate() {
    if (!state.videoReady) {
      els.frameEstimate.value = '—';
      return;
    }
    const fps = clamp(parseFloat(els.fpsInput.value) || 24, 1, 120);
    const start = clamp(parseFloat(els.startTimeInput.value) || 0, 0, state.duration);
    let end = parseFloat(els.endTimeInput.value);
    if (!Number.isFinite(end)) end = state.duration;
    end = clamp(end, 0, state.duration);
    if (end <= start) {
      els.frameEstimate.value = '—';
      return;
    }
    const raw = Math.max(1, Math.round((end - start) * fps));
    els.frameEstimate.value = raw > MAX_FRAMES ? `${MAX_FRAMES} / ${raw} 帧` : `${raw} 帧`;
  }

  async function extractFrames() {
    if (!state.videoReady) return showToast('请先导入视频。', 'warn');
    if (state.extracting) return;
    if (state.busy.active || state.detecting) return;
    if (state.playing) stopPlayback();

    const fps = clamp(parseFloat(els.fpsInput.value) || 24, 1, 120);
    const start = clamp(parseFloat(els.startTimeInput.value) || 0, 0, state.duration);
    let end = parseFloat(els.endTimeInput.value);
    if (!Number.isFinite(end)) end = state.duration;
    end = clamp(end, 0, state.duration);
    if (end - start < 0.001) {
      showToast('结束时间必须大于起始时间。', 'error');
      return;
    }

    const rawCount = Math.max(1, Math.round((end - start) * fps));
    const count = Math.min(rawCount, MAX_FRAMES);
    if (rawCount > MAX_FRAMES) {
      showToast(`单次最多提取 ${MAX_FRAMES} 帧，当前范围可提取 ${rawCount} 帧，将截取前 ${MAX_FRAMES} 帧。`, 'warn', 4500);
    }

    if (state.track.length) {
      const ok = await confirmDialog({
        title: '重新提取会清空轨道',
        message: '当前轨道中有选中的帧，重新提取会清空轨道。已经追加到图集的内容不会受影响。',
        confirmText: '继续提取'
      });
      if (!ok) return;
    }

    const token = ++state.extractToken;
    state.extracting = true;
    els.extractProgress.hidden = false;
    els.extractLabel.textContent = '正在提取序列帧…';
    els.cancelExtractBtn.disabled = false;
    els.extractBar.style.width = '0%';
    els.extractSub.textContent = `0 / ${count}`;
    syncVideoUI();

    const frames = [];
    const thumbMax = 800;

    try {
      for (let index = 0; index < count; index++) {
        if (token !== state.extractToken) throw { canceled: true };
        const time = Math.min(start + index / fps, Math.max(start, end - 0.0005));
        await seekVideo(els.video, time);
        if (token !== state.extractToken) throw { canceled: true };

        const scale = Math.min(1, thumbMax / state.videoWidth);
        const width = Math.max(1, Math.round(state.videoWidth * scale));
        const height = Math.max(1, Math.round(state.videoHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(els.video, 0, 0, width, height);

        let thumbURL;
        try {
          thumbURL = canvas.toDataURL('image/webp', 0.92);
          if (!thumbURL.startsWith('data:image/webp')) thumbURL = canvas.toDataURL('image/png');
        } catch (error) {
          thumbURL = canvas.toDataURL('image/png');
        }

        frames.push({
          index,
          time,
          width: state.videoWidth,
          height: state.videoHeight,
          thumbURL,
          _image: null,
          _keyed: null,
          _keySig: ''
        });

        els.extractBar.style.width = `${((index + 1) / count) * 100}%`;
        els.extractSub.textContent = `${index + 1} / ${count}`;
        els.extractLabel.textContent = `正在提取序列帧… ${Math.round(((index + 1) / count) * 100)}%`;
        if (index % 3 === 0) await nextFrame();
      }

      if (token !== state.extractToken) throw { canceled: true };

      state.frames = frames;
      state.track = [];
      state.current = -1;
      renderFrameGrid();
      renderTrack();
      syncPreviewUI();
      syncVideoUI();
      updateFrameEstimate();
      syncAtlasDependentUI();
      drawPreview();

      els.extractProgress.hidden = true;
      showToast(`已提取 ${frames.length} 帧`, 'ok');
      const frameHead = $('.frame-section-head');
      if (frameHead) frameHead.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      if (error && error.canceled) {
        showToast('已取消提取', 'warn');
      } else {
        console.error(error);
        showToast(`提取失败：${error.message || '未知错误'}`, 'error', 4000);
      }
      els.extractProgress.hidden = true;
    } finally {
      state.extracting = false;
      els.cancelExtractBtn.disabled = false;
      syncVideoUI();
    }
  }

  function cancelExtraction() {
    if (!state.extracting) return;
    state.extractToken++;
    els.extractLabel.textContent = '正在取消…';
    els.cancelExtractBtn.disabled = true;
  }

  async function detectVideoFps() {
    if (!state.videoReady || state.extracting || state.detecting || state.busy.active) return;
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      showToast('当前浏览器不支持自动检测帧率，请手动填写。', 'warn');
      return;
    }
    state.detecting = true;
    els.detectFpsBtn.disabled = true;
    els.detectFpsBtn.textContent = '检测中';
    const video = els.video;
    const previousTime = video.currentTime || 0;
    video.muted = true;

    try {
      const fps = await probeVideoFps(video);
      if (fps) {
        els.fpsInput.value = fps;
        updateFrameEstimate();
        showToast(`检测到约 ${fps} FPS`, 'ok');
      } else {
        showToast('自动检测失败，请手动填写帧率。', 'warn');
      }
    } catch (error) {
      console.error(error);
      showToast('自动检测失败，请手动填写帧率。', 'warn');
    } finally {
      video.pause();
      await seekVideo(video, previousTime).catch(() => {});
      state.detecting = false;
      els.detectFpsBtn.disabled = false;
      els.detectFpsBtn.textContent = '检测';
      syncVideoUI();
    }
  }

  function probeVideoFps(video) {
    return new Promise((resolve) => {
      const times = [];
      let handle = 0;
      let done = false;
      let timeout = 0;
      const overall = setTimeout(finish, 2600);

      function cleanup() {
        clearTimeout(overall);
        clearTimeout(timeout);
        if (handle && video.cancelVideoFrameCallback) {
          try { video.cancelVideoFrameCallback(handle); } catch (error) { /* noop */ }
        }
      }
      function finish() {
        if (done) return;
        done = true;
        cleanup();
        video.pause();
        const deltas = [];
        for (let i = 1; i < times.length; i++) {
          const delta = times[i] - times[i - 1];
          if (delta > 0.001 && delta < 0.25) deltas.push(delta);
        }
        if (deltas.length < 3) return resolve(null);
        deltas.sort((a, b) => a - b);
        const median = deltas[Math.floor(deltas.length / 2)];
        let fps = 1 / median;
        let best = fps;
        for (const candidate of FPS_CANDIDATES) {
          if (Math.abs(candidate - fps) / candidate < 0.035) {
            best = candidate;
            break;
          }
        }
        resolve(Math.round(best * 1000) / 1000);
      }
      function onFrame(now, metadata) {
        if (done) return;
        times.push(metadata.mediaTime);
        if (times.length >= 24) {
          finish();
          return;
        }
        handle = video.requestVideoFrameCallback(onFrame);
      }

      video.currentTime = 0;
      video.play().then(() => {
        if (done) return;
        handle = video.requestVideoFrameCallback(onFrame);
        timeout = setTimeout(finish, 1800);
      }).catch(finish);
    });
  }

  function syncVideoUI() {
    const ready = state.videoReady;
    els.videoLoaded.hidden = !ready;
    els.videoEmpty.hidden = ready;
    els.extractBtn.disabled = !ready || state.extracting || state.detecting;
    els.detectFpsBtn.disabled = !ready || state.extracting || state.detecting;
    if (!state.extracting) {
      els.extractBtn.querySelector('span').textContent = '提取序列帧';
    }
    if (!ready) {
      els.videoBadge.textContent = '未导入';
      els.videoBadge.className = 'chip chip-muted';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Frame selection and timeline                                        */
  /* ------------------------------------------------------------------ */

  let framePeekTarget = null;
  let framePeekShown = null;
  let framePeekShowTimer = 0;
  let framePeekHideTimer = 0;

  function frameCardFromEvent(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    const card = target.closest('.frame-card');
    return card && els.frameGrid.contains(card) ? card : null;
  }

  function onFrameGridPointerMove(event) {
    if (event.pointerType === 'touch') return;
    const card = frameCardFromEvent(event);
    if (!card) {
      framePeekTarget = null;
      scheduleFramePeekHide(70);
      return;
    }
    if (card === framePeekTarget) {
      return;
    }
    framePeekTarget = card;
    clearTimeout(framePeekShowTimer);
    clearTimeout(framePeekHideTimer);
    if (framePeekShown === card) {
      return;
    }
    framePeekShowTimer = setTimeout(() => {
      if (framePeekTarget === card) showFramePeek(card);
    }, 110);
  }

  function onFrameGridPointerLeave() {
    framePeekTarget = null;
    clearTimeout(framePeekShowTimer);
    scheduleFramePeekHide(70);
  }

  function onFrameGridFocusIn(event) {
    const card = frameCardFromEvent(event);
    if (!card) return;
    framePeekTarget = card;
    clearTimeout(framePeekShowTimer);
    clearTimeout(framePeekHideTimer);
    showFramePeek(card);
  }

  function onFrameGridFocusOut(event) {
    const next = event.relatedTarget;
    if (next && els.frameGrid.contains(next)) return;
    framePeekTarget = null;
    scheduleFramePeekHide(70);
  }

  function showFramePeek(card) {
    if (!card || !card.isConnected) return;
    const index = Number(card.dataset.index);
    const frame = state.frames[index];
    if (!frame) return;

    clearTimeout(framePeekHideTimer);
    framePeekShown = card;
    els.framePeekImage.src = frame.thumbURL;
    els.framePeekImage.alt = `第 ${index + 1} 帧预览`;
    els.framePeekIndex.textContent = `#${pad3(index + 1)}`;
    els.framePeekTime.textContent = `${frame.time.toFixed(2)} s`;
    els.framePeekSize.textContent = `${frame.width} × ${frame.height}`;
    els.framePeek.hidden = false;
    els.framePeek.setAttribute('aria-hidden', 'false');
    positionFramePeek();

    if (els.framePeekImage.decode) {
      els.framePeekImage.decode().then(() => {
        if (framePeekShown === card && !els.framePeek.hidden) positionFramePeek();
      }).catch(() => {});
    } else {
      requestAnimationFrame(() => positionFramePeek());
    }
  }

  function positionFramePeek() {
    if (els.framePeek.hidden) return;
    const panel = els.framePeek;
    const width = panel.offsetWidth || 480;
    const height = panel.offsetHeight || 320;
    const margin = 12;
    const gap = 14;
    const gridRect = els.frameGrid.getBoundingClientRect();

    // Park the preview in one fixed slot beside the source grid so frames can
    // be compared without the window jumping around under the cursor.
    let left = gridRect.right + gap;
    left = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));
    const top = clamp(
      Math.round(window.innerHeight * 0.18),
      margin,
      Math.max(margin, window.innerHeight - height - margin)
    );
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${top}px`;
  }

  function scheduleFramePeekHide(delay) {
    clearTimeout(framePeekHideTimer);
    framePeekHideTimer = setTimeout(() => {
      if (!framePeekTarget) hideFramePeek(true);
    }, delay);
  }

  function hideFramePeek(immediate) {
    clearTimeout(framePeekShowTimer);
    clearTimeout(framePeekHideTimer);
    framePeekTarget = null;
    const commit = () => {
      framePeekShown = null;
      if (!els.framePeek.hidden) {
        els.framePeek.hidden = true;
        els.framePeek.setAttribute('aria-hidden', 'true');
      }
    };
    if (immediate) commit();
    else framePeekHideTimer = setTimeout(commit, 70);
  }

  function renderFrameGrid() {
    hideFramePeek(true);
    els.frameGrid.innerHTML = '';
    els.frameEmpty.hidden = state.frames.length > 0;
    els.frameCount.textContent = state.frames.length;

    if (state.frames.length) {
      const fragment = document.createDocumentFragment();
      state.frames.forEach((frame, index) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'frame-card';
        card.dataset.index = String(index);
        card.title = `第 ${index + 1} 帧 · ${frame.time.toFixed(2)} 秒`;

        const image = document.createElement('img');
        image.src = frame.thumbURL;
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';

        const shade = document.createElement('span');
        shade.className = 'frame-shade';

        const frameIndex = document.createElement('span');
        frameIndex.className = 'frame-index';
        frameIndex.textContent = `#${pad3(index + 1)}`;

        const frameTime = document.createElement('span');
        frameTime.className = 'frame-time';
        frameTime.textContent = `${frame.time.toFixed(2)}s`;

        const order = document.createElement('span');
        order.className = 'frame-order';
        order.textContent = '';

        const check = document.createElement('span');
        check.className = 'frame-check';
        check.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>';

        card.append(image, shade, frameIndex, frameTime, order, check);
        fragment.appendChild(card);
      });
      els.frameGrid.appendChild(fragment);
    }

    updateSelectionUI();
  }

  function toggleFrame(index) {
    if (!Number.isInteger(index) || !state.frames[index]) return;
    stopPlayback();
    const position = state.track.indexOf(index);
    if (position >= 0) {
      state.track.splice(position, 1);
      if (position < state.current) state.current--;
      if (state.current >= state.track.length) state.current = state.track.length - 1;
    } else {
      state.track.push(index);
      state.current = state.track.length - 1;
    }
    if (!state.track.length) state.current = -1;
    renderTrack();
    updateSelectionUI();
    syncPreviewUI();
    schedulePreviewDraw();
  }

  function selectAllFrames() {
    if (!state.frames.length) return;
    stopPlayback();
    const existing = new Set(state.track);
    state.frames.forEach((frame, index) => {
      if (!existing.has(index)) state.track.push(index);
    });
    if (state.current < 0) state.current = state.track.length - 1;
    renderTrack();
    updateSelectionUI();
    syncPreviewUI();
    schedulePreviewDraw();
    showToast(`轨道中已有 ${state.track.length} 帧`, 'ok');
  }

  function clearTrack(showMessage = false) {
    if (!state.track.length) return;
    stopPlayback();
    state.track = [];
    state.current = -1;
    renderTrack();
    updateSelectionUI();
    syncPreviewUI();
    schedulePreviewDraw();
    if (showMessage) showToast('已清空轨道');
  }

  function updateSelectionUI() {
    const orderMap = new Map();
    state.track.forEach((frameIndex, order) => orderMap.set(frameIndex, order));
    els.frameGrid.querySelectorAll('.frame-card').forEach((card) => {
      const index = Number(card.dataset.index);
      const order = orderMap.get(index);
      const selected = order !== undefined;
      card.classList.toggle('selected', selected);
      const badge = card.querySelector('.frame-order');
      if (badge) badge.textContent = selected ? String(order + 1).padStart(2, '0') : '';
    });
    els.selectAllBtn.disabled = !state.frames.length;
    els.clearSelectionBtn.disabled = !state.track.length;
    els.frameCount.textContent = state.frames.length;
  }

  function renderTrack(options = {}) {
    const previousScroll = els.timeline.scrollLeft;
    if (!state.track.length) {
      els.timeline.innerHTML = `
        <div class="timeline-empty">
          <div class="timeline-empty-icon"><svg class="icon"><use href="#i-move"/></svg></div>
          <div>
            <strong>轨道还是空的</strong>
            <span>从左侧选择帧，选中顺序会成为播放顺序；拖动卡片可重新排序</span>
          </div>
        </div>`;
    } else {
      els.timeline.innerHTML = state.track.map((frameIndex, trackIndex) => {
        const frame = state.frames[frameIndex];
        if (!frame) return '';
        return `
          <div class="clip${trackIndex === state.current ? ' active' : ''}" draggable="true"
               data-track-index="${trackIndex}" data-frame-index="${frameIndex}"
               title="第 ${trackIndex + 1} 帧 · 源帧 #${pad3(frameIndex + 1)} · ${frame.time.toFixed(2)}s">
            <div class="clip-image">
              <img src="${frame.thumbURL}" alt="" draggable="false">
              <span class="clip-order">${pad2(trackIndex + 1)}</span>
              <button class="clip-remove" type="button" data-remove="${trackIndex}" title="从轨道移除">
                <svg class="icon"><use href="#i-x"/></svg>
              </button>
            </div>
            <div class="clip-meta">
              <span class="clip-index">#${pad3(frameIndex + 1)}</span>
              <span class="clip-time">${frame.time.toFixed(2)}s</span>
            </div>
            <div class="clip-actions">
              <button class="clip-move" type="button" data-move="-1" data-track-index="${trackIndex}" title="向前移动">
                <svg class="icon"><use href="#i-chevron-left"/></svg>
              </button>
              <button class="clip-move" type="button" data-move="1" data-track-index="${trackIndex}" title="向后移动">
                <svg class="icon"><use href="#i-chevron-right"/></svg>
              </button>
            </div>
          </div>`;
      }).join('');
    }
    if (!options.keepScroll) {
      els.timeline.scrollLeft = options.scrollToEnd ? els.timeline.scrollWidth : previousScroll;
    }
    updateActiveClip(Boolean(options.scrollToCurrent));
  }

  function updateActiveClip(scrollIntoView) {
    const clips = els.timeline.querySelectorAll('.clip');
    let active = null;
    clips.forEach((clip) => {
      const isActive = Number(clip.dataset.trackIndex) === state.current;
      clip.classList.toggle('active', isActive);
      if (isActive) active = clip;
    });
    if (!active || !scrollIntoView) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    const viewLeft = els.timeline.scrollLeft;
    const viewRight = viewLeft + els.timeline.clientWidth;
    if (left < viewLeft + 8) {
      els.timeline.scrollTo({ left: Math.max(0, left - 10), behavior: 'smooth' });
    } else if (right > viewRight - 8) {
      els.timeline.scrollTo({ left: right - els.timeline.clientWidth + 10, behavior: 'smooth' });
    }
  }

  function onTimelineClick(event) {
    const removeButton = event.target.closest('[data-remove]');
    if (removeButton) {
      event.stopPropagation();
      removeTrackAt(Number(removeButton.dataset.remove));
      return;
    }
    const moveButton = event.target.closest('[data-move]');
    if (moveButton) {
      event.stopPropagation();
      moveTrackItem(Number(moveButton.dataset.trackIndex), Number(moveButton.dataset.move));
      return;
    }
    const clip = event.target.closest('.clip');
    if (clip) {
      stopPlayback();
      setCurrent(Number(clip.dataset.trackIndex), true);
    }
  }

  function removeTrackAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.track.length) return;
    stopPlayback();
    state.track.splice(index, 1);
    if (state.current > index) state.current--;
    if (state.current >= state.track.length) state.current = state.track.length - 1;
    if (!state.track.length) state.current = -1;
    renderTrack();
    updateSelectionUI();
    syncPreviewUI();
    schedulePreviewDraw();
  }

  function moveTrackItem(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= state.track.length) return;
    stopPlayback();
    const activeFrame = state.track[state.current];
    const [item] = state.track.splice(index, 1);
    state.track.splice(target, 0, item);
    if (activeFrame !== undefined) {
      const newIndex = state.track.indexOf(activeFrame);
      if (newIndex >= 0) state.current = newIndex;
    }
    renderTrack({ keepScroll: true });
    updateSelectionUI();
    syncPreviewUI();
    schedulePreviewDraw();
    updateActiveClip(true);
  }

  function reorderTrack(from, targetIndex, after) {
    if (from === targetIndex && !after) return;
    const activeFrame = state.track[state.current];
    const [item] = state.track.splice(from, 1);
    let insert = targetIndex + (after ? 1 : 0);
    if (from < insert) insert--;
    insert = clamp(insert, 0, state.track.length);
    state.track.splice(insert, 0, item);
    if (activeFrame !== undefined) {
      const newIndex = state.track.indexOf(activeFrame);
      if (newIndex >= 0) state.current = newIndex;
    }
    renderTrack({ keepScroll: true });
    updateSelectionUI();
    syncPreviewUI();
    schedulePreviewDraw();
    updateActiveClip(true);
  }

  function onClipDragStart(event) {
    const clip = event.target.closest('.clip');
    if (!clip) return;
    state.dragIndex = Number(clip.dataset.trackIndex);
    state.dragTarget = null;
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', String(state.dragIndex)); } catch (error) { /* noop */ }
    requestAnimationFrame(() => clip.classList.add('dragging'));
  }

  function onClipDragOver(event) {
    if (state.dragIndex < 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const clip = event.target.closest('.clip');
    els.timeline.querySelectorAll('.clip').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
    if (clip) {
      const rect = clip.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      clip.classList.add(after ? 'drop-after' : 'drop-before');
      state.dragTarget = { index: Number(clip.dataset.trackIndex), after };
    } else {
      state.dragTarget = { index: state.track.length, after: false };
    }
  }

  function onClipDragLeave(event) {
    if (event.target === els.timeline) return;
    if (!els.timeline.contains(event.relatedTarget)) {
      els.timeline.querySelectorAll('.clip').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
    }
  }

  function onClipDrop(event) {
    if (state.dragIndex < 0) return;
    event.preventDefault();
    const target = state.dragTarget || { index: state.track.length, after: false };
    const from = state.dragIndex;
    clearDragState();
    reorderTrack(from, target.index, target.after);
  }

  function clearDragState() {
    state.dragIndex = -1;
    state.dragTarget = null;
    els.timeline.querySelectorAll('.clip').forEach((item) => {
      item.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Preview and playback                                                */
  /* ------------------------------------------------------------------ */

  function currentFrame() {
    if (state.current < 0 || state.current >= state.track.length) return null;
    return state.frames[state.track[state.current]] || null;
  }

  function getFrameImage(frame) {
    if (frame._image && frame._image.complete && frame._image.naturalWidth > 0) return frame._image;
    if (!frame._image) {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => schedulePreviewDraw();
      image.src = frame.thumbURL;
      frame._image = image;
    }
    return null;
  }

  function getFrameImageAsync(frame, timeout = 4000) {
    return new Promise((resolve) => {
      const immediate = getFrameImage(frame);
      if (immediate) { resolve(immediate); return; }
      const image = frame._image;
      if (!image) { resolve(null); return; }
      let settled = false;
      const timer = setTimeout(finish, timeout);
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.removeEventListener('load', finish);
        image.removeEventListener('error', finish);
        resolve(getFrameImage(frame));
      }
      image.addEventListener('load', finish);
      image.addEventListener('error', finish);
      if (image.complete) finish();
    });
  }

  function getKeyedFrame(frame) {
    const image = getFrameImage(frame);
    if (!image) return null;
    const signature = `${state.key.color}|${state.key.tolerance}|${state.key.feather}`;
    if (frame._keyed && frame._keySig === signature) return frame._keyed;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    applyChromaKey(context, canvas.width, canvas.height, state.key);
    frame._keyed = canvas;
    frame._keySig = signature;
    return canvas;
  }

  function applyChromaKey(context, width, height, key) {
    if (!key.enabled) return;
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    const [keyR, keyG, keyB] = hexToRgb(key.color);
    const tolerance = Math.max(0, Number(key.tolerance) || 0);
    const feather = Math.max(0, Number(key.feather) || 0);
    const featherEnd = tolerance + feather;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;
      const dr = data[i] - keyR;
      const dg = data[i + 1] - keyG;
      const db = data[i + 2] - keyB;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      if (distance <= tolerance) {
        data[i + 3] = 0;
      } else if (feather > 0 && distance < featherEnd) {
        data[i + 3] = Math.max(0, Math.round(alpha * ((distance - tolerance) / feather)));
      }
    }
    context.putImageData(imageData, 0, 0);
  }

  function invalidateKeyCache() {
    state.frames.forEach((frame) => {
      frame._keyed = null;
      frame._keySig = '';
    });
  }

  function onKeySettingsChanged() {
    invalidateKeyCache();
    syncChromaControls();
    syncPreviewUI();
    schedulePreviewDraw();
    savePrefs();
  }

  function schedulePreviewDraw() {
    if (state.previewRaf) return;
    state.previewRaf = requestAnimationFrame(() => {
      state.previewRaf = 0;
      drawPreview();
    });
  }

  function drawPreview() {
    const canvas = els.previewCanvas;
    const rect = els.previewStage.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width);
    const cssHeight = Math.max(1, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const frame = currentFrame();
    if (!frame) return;
    const image = state.key.enabled ? getKeyedFrame(frame) : getFrameImage(frame);
    if (!image) return;

    const srcWidth = image.naturalWidth || image.width;
    const srcHeight = image.naturalHeight || image.height;
    if (!srcWidth || !srcHeight) return;

    const padding = Math.max(14, Math.min(38, Math.min(cssWidth, cssHeight) * 0.045));
    const availableWidth = Math.max(1, cssWidth - padding * 2);
    const availableHeight = Math.max(1, cssHeight - padding * 2);
    const scale = Math.min(availableWidth / srcWidth, availableHeight / srcHeight);
    const drawWidth = srcWidth * scale;
    const drawHeight = srcHeight * scale;
    const dx = (cssWidth - drawWidth) / 2;
    const dy = (cssHeight - drawHeight) / 2;

    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (state.key.enabled) {
      context.shadowColor = 'rgba(0, 0, 0, .42)';
      context.shadowBlur = 26;
      context.shadowOffsetY = 9;
    }
    context.drawImage(image, dx, dy, drawWidth, drawHeight);
    context.restore();
  }

  function syncPreviewUI() {
    const frame = currentFrame();
    const count = state.track.length;
    const fps = Math.max(1, state.previewFps);

    els.previewEmpty.hidden = Boolean(frame);
    els.stageBadges.hidden = !frame;
    els.previewMeta.textContent = frame ? `${frame.width} × ${frame.height} · ${frame.time.toFixed(2)}s` : '—';
    els.stageSizeBadge.textContent = frame ? `${frame.width} × ${frame.height}` : '—';
    els.stageAlphaBadge.hidden = !(frame && state.key.enabled);

    els.trackBadge.textContent = `${count} 帧`;
    els.addToAtlasBtn.disabled = !count;
    els.clearTrackBtn.disabled = !count;
    els.appendHintBtn.disabled = !count;
    els.appendHintBtn.querySelector('span').textContent = count ? `追加当前轨道（${count} 帧）` : '先在轨道中选择帧';

    const disabled = count === 0;
    [els.firstBtn, els.prevBtn, els.nextBtn, els.lastBtn].forEach((button) => { button.disabled = disabled; });
    els.playBtn.disabled = disabled;
    els.scrubber.disabled = disabled;
    els.scrubber.max = String(Math.max(0, count - 1));
    els.scrubber.value = String(Math.max(0, state.current));
    const scrubPercent = count <= 1 ? 0 : (Math.max(0, state.current) / (count - 1)) * 100;
    els.scrubber.style.setProperty('--scrub', `${scrubPercent}%`);

    els.timecode.textContent = `${formatClock(state.current / fps)} / ${formatClock(count / fps)}`;
    els.previewStage.classList.toggle('checker', state.bgMode === 'checker');
    els.previewStage.classList.toggle('dark', state.bgMode === 'dark');
    els.bgToggleBtn.title = state.bgMode === 'checker' ? '切换为纯色背景' : '切换为透明棋盘格';

    setPlayIcon(state.playing);
    updateActiveClip(false);
  }

  function setPlayIcon(playing) {
    els.playBtn.innerHTML = playing ? icons.pause : icons.play;
    els.playBtn.title = playing ? '暂停（空格）' : '播放 / 暂停（空格）';
  }

  function setCurrent(index, scrollIntoView = false) {
    if (!state.track.length) {
      state.current = -1;
      syncPreviewUI();
      drawPreview();
      return;
    }
    state.current = clamp(index, 0, state.track.length - 1);
    syncPreviewUI();
    updateActiveClip(scrollIntoView);
    drawPreview();
  }

  function stepFrame(direction) {
    if (!state.track.length) return;
    let next = state.current + direction;
    if (next < 0) next = els.loopToggle.checked ? state.track.length - 1 : 0;
    if (next >= state.track.length) next = els.loopToggle.checked ? 0 : state.track.length - 1;
    setCurrent(next, true);
  }

  function togglePlayback() {
    if (!state.track.length) return;
    if (state.playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function startPlayback() {
    if (!state.track.length) return;
    if (state.current < 0 || state.current >= state.track.length - 1) setCurrent(0, true);
    state.playing = true;
    state.lastTs = performance.now();
    state.playAcc = 0;
    setPlayIcon(true);
    state.playRaf = requestAnimationFrame(playTick);
  }

  function stopPlayback() {
    if (!state.playing) {
      setPlayIcon(false);
      return;
    }
    state.playing = false;
    if (state.playRaf) cancelAnimationFrame(state.playRaf);
    state.playRaf = 0;
    state.playAcc = 0;
    setPlayIcon(false);
    syncPreviewUI();
  }

  function playTick(timestamp) {
    if (!state.playing) return;
    const interval = 1000 / Math.max(1, state.previewFps);
    let delta = timestamp - state.lastTs;
    state.lastTs = timestamp;
    if (delta > 500) delta = interval;
    state.playAcc += delta;

    let steps = 0;
    while (state.playAcc >= interval && steps < 8) {
      state.playAcc -= interval;
      steps++;
    }

    if (steps > 0) {
      let next = state.current + steps;
      if (next >= state.track.length) {
        if (els.loopToggle.checked) {
          next %= state.track.length;
        } else {
          setCurrent(state.track.length - 1, true);
          stopPlayback();
          return;
        }
      }
      setCurrent(next, true);
    }
    state.playRaf = requestAnimationFrame(playTick);
  }

  /* ------------------------------------------------------------------ */
  /* Settings and chroma key                                             */
  /* ------------------------------------------------------------------ */

  function onSettingsChanged() {
    syncGridReadout();
    savePrefs();
  }

  function normalizeSettingsInputs() {
    if (state.atlas.pages.length) return;
    els.atlasWidthInput.value = readInt(els.atlasWidthInput, 16, MAX_CANVAS, 2048);
    els.atlasHeightInput.value = readInt(els.atlasHeightInput, 16, MAX_CANVAS, 2048);
    els.rowsInput.value = readInt(els.rowsInput, 1, 64, 4);
    els.colsInput.value = readInt(els.colsInput, 1, 64, 4);
    syncGridReadout();
    savePrefs();
  }

  function getConfigFromInputs() {
    const width = readInt(els.atlasWidthInput, 16, MAX_CANVAS, 2048);
    const height = readInt(els.atlasHeightInput, 16, MAX_CANVAS, 2048);
    const rows = readInt(els.rowsInput, 1, 64, 4);
    const cols = readInt(els.colsInput, 1, 64, 4);
    const cellWidth = Math.floor(width / cols);
    const cellHeight = Math.floor(height / rows);
    if (cellWidth < 8 || cellHeight < 8) {
      throw new Error('单格尺寸太小（至少 8 × 8 px），请减少行列数或增大画布。');
    }
    if (width * height > 8192 * 8192) {
      throw new Error('画布尺寸过大。');
    }
    els.atlasWidthInput.value = width;
    els.atlasHeightInput.value = height;
    els.rowsInput.value = rows;
    els.colsInput.value = cols;
    return { width, height, rows, cols, cellWidth, cellHeight };
  }

  function syncGridReadout() {
    const width = readInt(els.atlasWidthInput, 16, MAX_CANVAS, 2048);
    const height = readInt(els.atlasHeightInput, 16, MAX_CANVAS, 2048);
    const rows = readInt(els.rowsInput, 1, 64, 4);
    const cols = readInt(els.colsInput, 1, 64, 4);
    const cellWidth = Math.floor(width / cols);
    const cellHeight = Math.floor(height / rows);
    els.cellSizeText.textContent = `${cellWidth} × ${cellHeight} px`;
    els.capacityText.textContent = `${rows * cols} 帧`;

    const displayRows = Math.min(rows, 8);
    const displayCols = Math.min(cols, 8);
    els.miniGrid.innerHTML = '';
    els.miniGrid.style.gridTemplateRows = `repeat(${displayRows}, 1fr)`;
    els.miniGrid.style.gridTemplateColumns = `repeat(${displayCols}, 1fr)`;
    els.miniGrid.title = `${rows} 行 × ${cols} 列`;
    for (let i = 0; i < displayRows * displayCols; i++) {
      const cell = document.createElement('i');
      if (i === 0) cell.className = 'on';
      els.miniGrid.appendChild(cell);
    }
  }

  function syncSettingsLock() {
    const locked = state.atlas.pages.length > 0;
    [els.atlasWidthInput, els.atlasHeightInput, els.rowsInput, els.colsInput].forEach((input) => {
      input.disabled = locked;
      input.title = locked ? '已有图集时布局被锁定，清空图集后可修改。' : '';
    });
    document.querySelectorAll('.preset-btn').forEach((button) => { button.disabled = locked; });
    els.settingsLock.hidden = !locked;
  }

  function syncChromaControls() {
    els.chromaToggle.checked = state.key.enabled;
    els.keyColorInput.value = state.key.color;
    if (document.activeElement !== els.keyColorText) els.keyColorText.value = state.key.color;
    els.toleranceInput.value = state.key.tolerance;
    els.toleranceValue.value = state.key.tolerance;
    els.featherInput.value = state.key.feather;
    els.featherValue.value = state.key.feather;
  }

  async function sampleBackgroundColor() {
    if (state.extracting || state.busy.active) return;
    let source = null;

    const frame = currentFrame() || state.frames[0];
    if (frame) {
      source = await getFrameImageAsync(frame);
    } else if (state.videoReady) {
      try {
        await seekVideo(els.video, 0.02);
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 18;
        canvas.getContext('2d').drawImage(els.video, 0, 0, 32, 18);
        source = canvas;
      } catch (error) {
        source = null;
      }
    }

    if (!source) {
      showToast('请先导入视频或提取帧，再取背景色。', 'warn');
      return;
    }

    const sample = document.createElement('canvas');
    sample.width = 24;
    sample.height = 24;
    const context = sample.getContext('2d');
    const sourceWidth = source.naturalWidth || source.width;
    const sourceHeight = source.naturalHeight || source.height;
    const sw = Math.max(1, Math.min(sourceWidth, Math.round(sourceWidth * 0.12)));
    const sh = Math.max(1, Math.min(sourceHeight, Math.round(sourceHeight * 0.12)));
    context.drawImage(source, 0, 0, sw, sh, 0, 0, 24, 24);
    const data = context.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
    if (!count) {
      showToast('取色失败：左上角是透明区域。', 'warn');
      return;
    }
    state.key.color = rgbToHex(r / count, g / count, b / count);
    state.key.enabled = true;
    els.chromaToggle.checked = true;
    syncChromaControls();
    invalidateKeyCache();
    syncPreviewUI();
    schedulePreviewDraw();
    savePrefs();
    showToast(`已取色 ${state.key.color}，并开启透明背景`, 'ok');
  }

  /* ------------------------------------------------------------------ */
  /* Atlas packing                                                       */
  /* ------------------------------------------------------------------ */

  function createAtlasPage(config) {
    const canvas = document.createElement('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    return {
      canvas,
      occupied: new Map(),
      previewURL: ''
    };
  }

  function clonePage(page) {
    const canvas = document.createElement('canvas');
    canvas.width = page.canvas.width;
    canvas.height = page.canvas.height;
    canvas.getContext('2d').drawImage(page.canvas, 0, 0);
    return {
      canvas,
      occupied: new Map(page.occupied),
      previewURL: ''
    };
  }

  function uniqueSequenceName(base) {
    const clean = String(base || '').trim() || '序列 1';
    const used = new Set(state.atlas.sequences.map((seq) => seq.name));
    if (!used.has(clean)) return clean;
    let index = 2;
    while (used.has(`${clean} (${index})`)) index++;
    return `${clean} (${index})`;
  }

  function defaultSequenceName() {
    const used = new Set(state.atlas.sequences.map((seq) => seq.name));
    let index = state.atlas.sequences.length + 1;
    let name = `序列 ${index}`;
    while (used.has(name)) {
      index++;
      name = `序列 ${index}`;
    }
    return name;
  }

  async function appendTrackToAtlas() {
    if (state.extracting) return showToast('请先等待提取完成。', 'warn');
    if (state.busy.active || state.detecting) return;
    if (!state.track.length) return showToast('轨道为空，请先从左侧选择帧。', 'warn');
    if (!state.videoReady) return showToast('视频未就绪，无法重新读取原始帧。', 'warn');

    let config = state.atlas.config;
    const createNew = state.atlas.pages.length === 0;
    if (createNew) {
      try {
        config = getConfigFromInputs();
      } catch (error) {
        showToast(error.message, 'error');
        return;
      }
    }
    if (!config) return showToast('图集配置缺失，请重新设置。', 'error');

    const count = state.track.length;
    const capacity = config.rows * config.cols;
    let startCell = state.atlas.nextCell || 0;

    // Keep a sequence in one page when it fits; only split very long sequences.
    if (count <= capacity) {
      const pageIndex = Math.floor(startCell / capacity);
      const offset = startCell % capacity;
      if (offset + count > capacity) startCell = (pageIndex + 1) * capacity;
    }

    const endCell = startCell + count - 1;
    const neededPages = Math.floor(endCell / capacity) + 1;
    if (neededPages > MAX_PAGES) {
      showToast(`图集页数超过 ${MAX_PAGES} 页上限，请增大画布或减少帧数。`, 'error', 4500);
      return;
    }

    const name = uniqueSequenceName(els.sequenceName.value || defaultSequenceName());
    const color = SEQ_COLORS[state.atlas.sequences.length % SEQ_COLORS.length];
    const stagedPages = state.atlas.pages.map(clonePage);
    while (stagedPages.length < neededPages) stagedPages.push(createAtlasPage(config));

    const placements = [];
    for (let index = 0; index < count; index++) {
      const globalCell = startCell + index;
      const pageIndex = Math.floor(globalCell / capacity);
      const cellIndex = globalCell % capacity;
      const row = Math.floor(cellIndex / config.cols);
      const col = cellIndex % config.cols;
      const frameIndex = state.track[index];
      placements.push({
        frameIndex,
        frame: state.frames[frameIndex],
        pageIndex,
        row,
        col,
        x: col * config.cellWidth,
        y: row * config.cellHeight
      });
    }

    let canceled = false;
    showBusy(`正在写入「${name}」`, `第 0 / ${count} 帧`);
    state.busy.cancel = () => {
      canceled = true;
      els.busySub.textContent = '正在取消，请稍候…';
      els.busyCancelBtn.disabled = true;
    };
    els.busyCancelBtn.hidden = false;
    els.busyCancelBtn.disabled = false;

    const keySnapshot = {
      enabled: state.key.enabled,
      color: state.key.color,
      tolerance: state.key.tolerance,
      feather: state.key.feather
    };

    try {
      for (let index = 0; index < count; index++) {
        if (canceled) throw { canceled: true };
        const placement = placements[index];
        await seekVideo(els.video, placement.frame.time);
        if (canceled) throw { canceled: true };

        drawVideoFrameToCell(
          els.video,
          stagedPages[placement.pageIndex].canvas,
          placement,
          config,
          keySnapshot
        );

        stagedPages[placement.pageIndex].occupied.set(`${placement.row + 1},${placement.col + 1}`, {
          sequence: name,
          frame: index
        });

        const percent = ((index + 1) / count) * 100;
        setBusyProgress(percent, `第 ${index + 1} / ${count} 帧 · ${placement.frame.time.toFixed(2)}s`);
      }

      if (canceled) throw { canceled: true };

      const sequenceFrames = placements.map((placement, index) => ({
        index,
        sourceIndex: placement.frameIndex,
        time: Number(placement.frame.time) || 0,
        page: placement.pageIndex + 1,
        row: placement.row + 1,
        col: placement.col + 1,
        startRow: placement.row + 1,
        startCol: placement.col + 1,
        endRow: placement.row + 1,
        endCol: placement.col + 1,
        x: placement.x,
        y: placement.y,
        width: config.cellWidth,
        height: config.cellHeight,
        label: `${name}_${pad3(index)}`
      }));

      const last = sequenceFrames[sequenceFrames.length - 1];
      const first = sequenceFrames[0];
      const sequence = {
        name,
        color,
        source: state.videoFile ? state.videoFile.name : '',
        frameCount: sequenceFrames.length,
        frames: sequenceFrames,
        start: { page: first.page, row: first.row, col: first.col },
        end: { page: last.page, row: last.row, col: last.col },
        thumbs: []
      };

      state.atlas.config = config;
      state.atlas.pages = stagedPages;
      state.atlas.nextCell = startCell + count;
      state.atlas.sequences.push(sequence);
      sequence.thumbs = buildSequenceThumbs(sequence);
      refreshPagePreviews();
      renderAtlasPanel();
      syncAtlasDependentUI();
      syncSettingsLock();

      clearTrack(false);
      els.sequenceName.value = defaultSequenceName();
      activateTab('atlas');
      showToast(
        `已追加「${name}」· ${count} 帧 · 第 ${first.page} 页 第 ${first.row} 行 ${first.col} 列 → 第 ${last.page} 页 第 ${last.row} 行 ${last.col} 列`,
        'ok',
        4200
      );
    } catch (error) {
      if (error && error.canceled) {
        showToast('已取消追加，图集未发生变化。', 'warn');
      } else {
        console.error(error);
        showToast(`写入图集失败：${error.message || '未知错误'}`, 'error', 4500);
      }
    } finally {
      hideBusy();
    }
  }

  function drawVideoFrameToCell(video, pageCanvas, placement, config, key) {
    const cellWidth = config.cellWidth;
    const cellHeight = config.cellHeight;
    const temp = document.createElement('canvas');
    temp.width = cellWidth;
    temp.height = cellHeight;
    const context = temp.getContext('2d');
    context.clearRect(0, 0, cellWidth, cellHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    const scale = Math.min(cellWidth / video.videoWidth, cellHeight / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    const dx = (cellWidth - drawWidth) / 2;
    const dy = (cellHeight - drawHeight) / 2;
    context.drawImage(video, dx, dy, drawWidth, drawHeight);
    applyChromaKey(context, cellWidth, cellHeight, key);

    const pageContext = pageCanvas.getContext('2d');
    pageContext.drawImage(temp, placement.x, placement.y);
  }

  function refreshPagePreviews() {
    state.atlas.pages.forEach((page) => {
      page.previewURL = makePagePreview(page, 460).toDataURL('image/webp', 0.88);
      if (!page.previewURL.startsWith('data:image/webp')) {
        page.previewURL = makePagePreview(page, 460).toDataURL('image/png');
      }
    });
  }

  function drawCheckerboard(context, width, height, size) {
    const cell = Math.max(4, size || 10);
    context.fillStyle = '#0b0e13';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#171d25';
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) {
          context.fillRect(x, y, cell, cell);
        }
      }
    }
  }

  function makePagePreview(page, maxSize) {
    const config = state.atlas.config;
    const scale = Math.min(1, maxSize / Math.max(config.width, config.height));
    const width = Math.max(1, Math.round(config.width * scale));
    const height = Math.max(1, Math.round(config.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    drawCheckerboard(context, width, height, Math.max(5, Math.round(12 * scale)));
    context.drawImage(page.canvas, 0, 0, width, height);

    const cellWidth = (config.cellWidth * width) / config.width;
    const cellHeight = (config.cellHeight * height) / config.height;
    context.save();
    context.strokeStyle = 'rgba(255, 255, 255, .18)';
    context.lineWidth = 1;
    for (let col = 1; col < config.cols; col++) {
      const x = Math.round(col * cellWidth) + 0.5;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let row = 1; row < config.rows; row++) {
      const y = Math.round(row * cellHeight) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.strokeStyle = 'rgba(255, 255, 255, .12)';
    context.strokeRect(0.5, 0.5, width - 1, height - 1);
    context.restore();
    return canvas;
  }

  function buildSequenceThumbs(sequence) {
    const thumbs = [];
    const total = sequence.frames.length;
    if (!total) return thumbs;
    const count = Math.min(6, total);
    for (let i = 0; i < count; i++) {
      const frameIndex = count === 1 ? 0 : Math.round((i / (count - 1)) * (total - 1));
      const frame = sequence.frames[frameIndex];
      const page = state.atlas.pages[frame.page - 1];
      if (!page) continue;
      const canvas = document.createElement('canvas');
      canvas.width = 72;
      canvas.height = Math.max(1, Math.round(72 * frame.height / frame.width));
      const context = canvas.getContext('2d');
      context.drawImage(page.canvas, frame.x, frame.y, frame.width, frame.height, 0, 0, canvas.width, canvas.height);
      thumbs.push(canvas.toDataURL('image/webp', 0.8));
    }
    return thumbs;
  }

  function atlasUsedCells() {
    return state.atlas.pages.reduce((total, page) => total + page.occupied.size, 0);
  }

  function renderAtlasPanel() {
    const pages = state.atlas.pages;
    const sequences = state.atlas.sequences;
    const hasAtlas = pages.length > 0;

    els.atlasEmpty.hidden = hasAtlas;
    els.atlasContent.hidden = !hasAtlas;

    if (!hasAtlas) {
      els.pageList.innerHTML = '';
      els.sequenceList.innerHTML = '';
      els.atlasTabBadge.hidden = true;
      return;
    }

    const used = atlasUsedCells();
    const capacity = pages.length * state.atlas.config.rows * state.atlas.config.cols;
    els.statPages.textContent = pages.length;
    els.statUsed.textContent = used;
    els.statCapacity.textContent = capacity;
    els.pageHint.textContent = `${state.atlas.config.width} × ${state.atlas.config.height} px`;
    els.sequenceHint.textContent = `${sequences.length} 个序列`;

    els.pageList.innerHTML = pages.map((page, index) => `
      <div class="page-item" data-page="${index}" title="点击查看页面 ${index + 1}">
        ${page.previewURL ? `<img src="${page.previewURL}" alt="图集页面 ${index + 1}">` : ''}
        <div class="page-info">
          <strong>页面 ${index + 1}</strong>
          <span>${page.occupied.size} / ${state.atlas.config.rows * state.atlas.config.cols} 格</span>
        </div>
      </div>`).join('');

    els.sequenceList.innerHTML = sequences.map((sequence, index) => {
      const start = sequence.start || sequence.frames[0];
      const end = sequence.end || sequence.frames[sequence.frames.length - 1];
      const pageText = start.page === end.page ? `第 ${start.page} 页` : `第 ${start.page} 页 → 第 ${end.page} 页`;
      const rangeText = `第 ${start.row} 行 ${start.col} 列 → 第 ${end.row} 行 ${end.col} 列`;
      return `
        <div class="seq-item" data-seq-index="${index}">
          <span class="seq-color" style="background:${normalizeHex(sequence.color) || SEQ_COLORS[0]}"></span>
          <div class="seq-main">
            <div class="seq-top">
              <span class="seq-name" title="${escapeHtml(sequence.name)}">${escapeHtml(sequence.name)}</span>
              <span class="seq-tools">
                <span class="seq-count">${sequence.frames.length} 帧</span>
                <button class="seq-remove" type="button" data-remove-seq="${index}" title="从图集中移除「${escapeHtml(sequence.name)}」" aria-label="从图集中移除「${escapeHtml(sequence.name)}」">
                  <svg class="icon"><use href="#i-trash"/></svg>
                </button>
              </span>
            </div>
            <div class="seq-range">${pageText} · ${rangeText}</div>
            <div class="seq-thumbs">
              ${sequence.thumbs.slice(0, 6).map((thumb) => `<img src="${thumb}" alt="">`).join('')}
            </div>
          </div>
        </div>`;
    }).join('');

    els.atlasTabBadge.hidden = sequences.length === 0;
    els.atlasTabBadge.textContent = sequences.length;
  }

  function syncAtlasDependentUI() {
    const pages = state.atlas.pages.length;
    const sequences = state.atlas.sequences.length;
    const frames = atlasUsedCells();
    const hasAtlas = pages > 0;

    els.exportBadge.hidden = !hasAtlas || sequences === 0;
    els.exportBadge.textContent = sequences;
    els.atlasTabBadge.hidden = !hasAtlas || sequences === 0;
    els.atlasTabBadge.textContent = sequences;
    els.statusDot.classList.toggle('live', hasAtlas || state.frames.length > 0);

    if (hasAtlas) {
      els.projectSummary.textContent = `${pages} 页 · ${sequences} 个序列 · ${frames} 帧`;
    } else if (state.videoReady) {
      els.projectSummary.textContent = '视频已就绪 · 图集为空';
    } else {
      els.projectSummary.textContent = '尚未创建图集';
    }
    els.clearAtlasBtn.disabled = !hasAtlas;
    syncSettingsLock();
  }

  async function clearAtlas() {
    if (!state.atlas.pages.length) return;
    const ok = await confirmDialog({
      title: '清空图集？',
      message: '将移除当前图集的所有页面和序列。已经下载到本地的文件不受影响。清空后布局尺寸可以重新设置。',
      confirmText: '清空图集',
      danger: true
    });
    if (!ok) return;
    state.atlas = { name: state.atlas.name, config: null, pages: [], sequences: [], nextCell: 0 };
    els.sequenceName.value = '序列 1';
    renderAtlasPanel();
    syncAtlasDependentUI();
    syncSettingsLock();
    showToast('图集已清空', 'ok');
  }

  async function removeSequenceAt(index) {
    if (state.extracting) return showToast('请先等待提取完成或取消提取。', 'warn');
    if (state.busy.active || state.detecting) return;
    if (!Number.isInteger(index)) return;
    const sequence = state.atlas.sequences[index];
    if (!sequence) return;

    const frameCount = sequence.frames.length;
    const ok = await confirmDialog({
      title: `移除序列「${sequence.name}」？`,
      message: `将从图集中删除这 ${frameCount} 帧，并把剩余序列向前重新排列；页面图片和图集 JSON 会同步更新。已经下载到本地的文件不受影响。`,
      confirmText: '移除并重排',
      danger: true
    });
    if (!ok) return;

    const currentIndex = state.atlas.sequences.indexOf(sequence);
    if (currentIndex < 0) return;
    repackAtlasWithout(currentIndex);
  }

  function repackAtlasWithout(removeIndex) {
    const atlas = state.atlas;
    const config = atlas.config;
    const oldPages = atlas.pages;
    if (!config || !oldPages.length) return;

    const removed = atlas.sequences[removeIndex];
    if (!removed) return;
    const remaining = atlas.sequences.filter((_, index) => index !== removeIndex);

    if (!remaining.length) {
      state.atlas = { name: state.atlas.name, config: null, pages: [], sequences: [], nextCell: 0 };
      els.sequenceName.value = '序列 1';
      renderAtlasPanel();
      syncAtlasDependentUI();
      syncSettingsLock();
      showToast(`已移除「${removed.name}」，图集已清空`, 'ok', 3600);
      return;
    }

    const capacity = config.rows * config.cols;
    const plans = [];
    let cursor = 0;

    // Sequences stay intact on one page when they fit; long sequences may split.
    for (const sequence of remaining) {
      const count = sequence.frames.length;
      let start = cursor;
      if (count <= capacity) {
        const offset = start % capacity;
        if (offset > 0 && offset + count > capacity) {
          start = Math.ceil(start / capacity) * capacity;
        }
      }
      const placements = sequence.frames.map((frame, frameIndex) => {
        const globalCell = start + frameIndex;
        const pageIndex = Math.floor(globalCell / capacity);
        const cellIndex = globalCell % capacity;
        const row = Math.floor(cellIndex / config.cols);
        const col = cellIndex % config.cols;
        return {
          frame,
          pageIndex,
          row,
          col,
          x: col * config.cellWidth,
          y: row * config.cellHeight
        };
      });
      cursor = start + count;
      plans.push({ sequence, placements });
    }

    const pageCount = Math.max(1, Math.ceil(cursor / capacity));
    if (pageCount > MAX_PAGES) {
      showToast(`重新排列后超过 ${MAX_PAGES} 页上限，未做修改。`, 'error', 4200);
      return;
    }

    try {
      const newPages = Array.from({ length: pageCount }, () => createAtlasPage(config));
      const newSequences = plans.map((plan) => {
        const frames = plan.placements.map((placement, frameIndex) => {
          const oldFrame = placement.frame;
          const oldPage = oldPages[oldFrame.page - 1];
          if (!oldPage) {
            throw new Error(`序列「${plan.sequence.name}」第 ${frameIndex + 1} 帧找不到原页面。`);
          }
          const sourceX = (oldFrame.col - 1) * config.cellWidth;
          const sourceY = (oldFrame.row - 1) * config.cellHeight;
          const page = newPages[placement.pageIndex];
          page.canvas.getContext('2d').drawImage(
            oldPage.canvas,
            sourceX,
            sourceY,
            config.cellWidth,
            config.cellHeight,
            placement.x,
            placement.y,
            config.cellWidth,
            config.cellHeight
          );
          page.occupied.set(`${placement.row + 1},${placement.col + 1}`, {
            sequence: plan.sequence.name,
            frame: frameIndex
          });
          return {
            ...oldFrame,
            index: frameIndex,
            page: placement.pageIndex + 1,
            row: placement.row + 1,
            col: placement.col + 1,
            startRow: placement.row + 1,
            startCol: placement.col + 1,
            endRow: placement.row + 1,
            endCol: placement.col + 1,
            x: placement.x,
            y: placement.y,
            width: config.cellWidth,
            height: config.cellHeight,
            label: oldFrame.label || `${plan.sequence.name}_${pad3(frameIndex)}`
          };
        });
        const first = frames[0];
        const last = frames[frames.length - 1];
        return {
          ...plan.sequence,
          frameCount: frames.length,
          frames,
          start: { page: first.page, row: first.row, col: first.col },
          end: { page: last.page, row: last.row, col: last.col },
          thumbs: []
        };
      });

      // Commit only after every cell has been copied successfully.
      atlas.pages = newPages;
      atlas.sequences = newSequences;
      atlas.nextCell = cursor;
      newSequences.forEach((sequence) => { sequence.thumbs = buildSequenceThumbs(sequence); });
      refreshPagePreviews();
      renderAtlasPanel();
      syncAtlasDependentUI();
      syncSettingsLock();
      showToast(
        `已移除「${removed.name}」· 剩余 ${newSequences.length} 个序列 · ${pageCount} 页`,
        'ok',
        4200
      );
    } catch (error) {
      console.error(error);
      showToast(`重新整理图集失败：${error.message || '未知错误'}`, 'error', 4500);
    }
  }

  function activateTab(name) {
    const tab = name === 'atlas' ? 'atlas' : 'settings';
    document.querySelectorAll('.side-tab').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    els.settingsPane.hidden = tab !== 'settings';
    els.atlasPane.hidden = tab !== 'atlas';
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */

  function buildAtlasJSON() {
    const config = state.atlas.config;
    const stem = atlasFileStem();
    const pages = state.atlas.pages.map((page, index) => ({
      index: index + 1,
      file: `${stem}_${pad2(index + 1)}.png`,
      width: config.width,
      height: config.height,
      rows: config.rows,
      cols: config.cols,
      cellWidth: config.cellWidth,
      cellHeight: config.cellHeight,
      usedCells: page.occupied.size,
      capacity: config.rows * config.cols
    }));

    const sequences = state.atlas.sequences.map((sequence) => {
      const frames = sequence.frames.map((frame) => ({
        index: frame.index,
        label: frame.label || `${sequence.name}_${pad3(frame.index)}`,
        sourceIndex: frame.sourceIndex ?? null,
        time: Number(frame.time) || 0,
        page: frame.page,
        row: frame.row,
        col: frame.col,
        startRow: frame.row,
        startCol: frame.col,
        endRow: frame.row,
        endCol: frame.col,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height
      }));
      const first = frames[0];
      const last = frames[frames.length - 1];
      return {
        name: sequence.name,
        color: sequence.color,
        source: sequence.source || '',
        frameCount: frames.length,
        start: { page: first.page, row: first.row, col: first.col },
        end: { page: last.page, row: last.row, col: last.col },
        startRow: first.row,
        startCol: first.col,
        endRow: last.row,
        endCol: last.col,
        frames
      };
    });

    return {
      version: 1,
      generator: 'SpriteForge / 序列帧工坊',
      exportedAt: new Date().toISOString(),
      coordinateSystem: {
        origin: 'top-left',
        rowBase: 1,
        colBase: 1,
        units: 'pixels'
      },
      atlas: {
        name: currentAtlasName(),
        width: config.width,
        height: config.height,
        rows: config.rows,
        cols: config.cols,
        cellWidth: config.cellWidth,
        cellHeight: config.cellHeight,
        pageCount: pages.length,
        usedCells: atlasUsedCells(),
        capacity: pages.length * config.rows * config.cols
      },
      pages,
      sequences
    };
  }

  function openExportModal() {
    if (!state.atlas.pages.length || !state.atlas.sequences.length) {
      showToast('图集为空：请先在轨道中选帧，然后点击「追加到图集」。', 'warn', 4000);
      activateTab('settings');
      return;
    }
    const config = state.atlas.config;
    const json = buildAtlasJSON();
    const pageCount = state.atlas.pages.length;
    const sequenceCount = state.atlas.sequences.length;
    const frameCount = atlasUsedCells();
    const stem = atlasFileStem();
    const displayName = currentAtlasName() || '未命名图集';

    const fileRows = state.atlas.pages.map((page, index) => `
      <div class="file-row">
        <span class="file-ico">PNG</span>
        <div class="file-row-main">
          <strong>${stem}_${pad2(index + 1)}.png</strong>
          <span>${config.width} × ${config.height} · 页面 ${index + 1}</span>
        </div>
        <button class="text-btn" type="button" data-download-page="${index}">下载</button>
      </div>`).join('') + `
      <div class="file-row">
        <span class="file-ico json">JSON</span>
        <div class="file-row-main">
          <strong>${stem}.json</strong>
          <span>${sequenceCount} 个序列 · 行列与像素位置</span>
        </div>
        <button class="text-btn" type="button" data-download-json>下载</button>
      </div>`;

    const modal = openModal({
      title: '导出图集',
      subtitle: `「${displayName}」 · PNG 保持透明通道；JSON 中的行列从 1 开始。`,
      wide: false,
      body: `
        <div class="export-summary">
          <div><span>页面</span><strong>${pageCount}</strong></div>
          <div><span>序列</span><strong>${sequenceCount}</strong></div>
          <div><span>帧数</span><strong>${frameCount}</strong></div>
        </div>
        <div class="file-list">${fileRows}</div>
        <div class="modal-note">推荐「下载 ZIP」：会一次性打包所有 PNG 与 ${stem}.json，之后可直接拖回本工具继续追加。</div>`,
      footer: `
        <button class="btn btn-ghost" type="button" data-close>关闭</button>
        <button class="btn btn-ghost" type="button" id="downloadJsonBtn">仅 JSON</button>
        ${readBridge() && typeof readBridge().saveAsset === 'function' ? `
        <button class="btn btn-ghost" type="button" id="saveAssetBtn">
          <svg class="icon"><use href="#i-upload"/></svg><span>${readBridge().saveLabel ? readBridge().saveLabel() : '保存到资产'}</span>
        </button>` : ''}
        <button class="btn btn-primary" type="button" id="downloadZipBtn">
          <svg class="icon"><use href="#i-download"/></svg><span>下载 ZIP</span>
        </button>`
    });

    modal.root.querySelectorAll('[data-download-page]').forEach((button) => {
      button.addEventListener('click', () => downloadAtlasPage(Number(button.dataset.downloadPage)));
    });
    modal.root.querySelector('[data-download-json]').addEventListener('click', downloadAtlasJSON);
    modal.root.querySelector('#downloadJsonBtn').addEventListener('click', downloadAtlasJSON);
    modal.root.querySelector('#downloadZipBtn').addEventListener('click', () => {
      modal.close();
      exportAtlasZip(json);
    });
    const saveBtn = modal.root.querySelector('#saveAssetBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        modal.close();
        await saveAtlasZip(json);
      });
    }
  }

  async function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG 编码失败。'));
      }, 'image/png');
    });
  }

  function downloadAtlasJSON() {
    const json = buildAtlasJSON();
    const filename = `${atlasFileStem()}.json`;
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, filename);
    showToast(`已下载 ${filename}`, 'ok');
  }

  async function downloadAtlasPage(index) {
    const page = state.atlas.pages[index];
    if (!page) return;
    try {
      const blob = await canvasToBlob(page.canvas);
      const filename = `${atlasFileStem()}_${pad2(index + 1)}.png`;
      downloadBlob(blob, filename);
      showToast(`已下载 ${filename}`, 'ok');
    } catch (error) {
      console.error(error);
      showToast(error.message, 'error');
    }
  }

  // MiraForge: 打包与「怎么处理这个 zip」拆开，宿主可以把同一个 blob 存进资产库。
  async function buildAtlasZip(json, progressLabel) {
    if (!state.atlas.pages.length) return null;
    const entries = [];
    const pageCount = state.atlas.pages.length;
    const stem = atlasFileStem(json.atlas && json.atlas.name);
    for (let index = 0; index < pageCount; index++) {
      setBusyProgress((index / pageCount) * 82, `${progressLabel || '正在编码 PNG'} ${index + 1} / ${pageCount}`);
      const blob = await canvasToBlob(state.atlas.pages[index].canvas);
      const buffer = await blob.arrayBuffer();
      const filename = (json.pages[index] && json.pages[index].file) || `${stem}_${pad2(index + 1)}.png`;
      entries.push({ name: filename, data: new Uint8Array(buffer) });
      await nextFrame();
    }
    const jsonData = zipEncoder.encode(JSON.stringify(json, null, 2));
    entries.push({ name: `${stem}.json`, data: jsonData });
    setBusyProgress(90, '正在生成 ZIP…');
    await nextFrame();
    const zip = buildZip(entries);
    setBusyProgress(100, '完成');
    const zipBase = normalizeAtlasName(json.atlas && json.atlas.name) ? stem : 'sprite_atlas';
    return { blob: new Blob([zip], { type: 'application/zip' }), name: `${zipBase}_${timestampForName()}.zip`, stem, pageCount };
  }

  async function exportAtlasZip(json) {
    if (!state.atlas.pages.length) return;
    showBusy('正在打包图集', '准备 PNG 页面…');
    try {
      const built = await buildAtlasZip(json);
      if (!built) return;
      downloadBlob(built.blob, built.name);
      showToast(`已导出 ${built.pageCount} 张 PNG 与 ${built.stem}.json`, 'ok', 4000);
    } catch (error) {
      console.error(error);
      showToast(`导出失败：${error.message || '未知错误'}`, 'error', 4500);
    } finally {
      hideBusy();
    }
  }

  async function saveAtlasZip(json) {
    const bridge = readBridge();
    if (!bridge || typeof bridge.saveAsset !== 'function') {
      return showToast('当前页面没有接入资产库。', 'warn');
    }
    if (!state.atlas.pages.length) return;
    showBusy('正在保存到资产', '准备 PNG 页面…');
    try {
      const built = await buildAtlasZip(json, '正在编码 PNG');
      if (!built) return;
      await bridge.saveAsset(built.blob, built.name);
      const savedLabel = typeof bridge?.saved ? bridge.saved(built) : '';
      showToast(savedLabel || `已保存到资产：${built.name}`, 'ok', 4000);
    } catch (error) {
      console.error(error);
      showToast(`保存失败：${error.message || '未知错误'}`, 'error', 4500);
    } finally {
      hideBusy();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Import atlas                                                        */
  /* ------------------------------------------------------------------ */

  async function handleAtlasFiles(files) {
    if (!files || !files.length) return;
    if (state.extracting) return showToast('请先等待提取完成或取消提取。', 'warn');
    if (state.busy.active) return;

    if (state.atlas.pages.length) {
      const ok = await confirmDialog({
        title: '替换当前图集？',
        message: '导入会替换当前编辑中的图集。尚未导出的页面和序列会丢失，已经下载的文件不受影响。',
        confirmText: '继续导入',
        danger: true
      });
      if (!ok) return;
    }

    showBusy('正在读取图集', '解析文件…');
    try {
      const array = Array.from(files);
      let jsonData = null;
      let fileMap = new Map();
      let baseName = 'atlas';

      if (array.length === 1 && /\.zip$/i.test(array[0].name)) {
        setBusyProgress(12, '解压 ZIP…');
        const entries = await readZipBuffer(await array[0].arrayBuffer());
        const jsonNames = Array.from(entries.keys()).filter((name) => /\.json$/i.test(name));
        const jsonName = jsonNames.find((name) => /(^|\/)atlas\.json$/i.test(name)) || jsonNames[0];
        if (!jsonName) throw new Error('ZIP 中没有找到图集 JSON 文件。');
        jsonData = entries.get(jsonName);
        baseName = jsonName.replace(/\.json$/i, '');
        for (const [name, data] of entries.entries()) {
          if (/\.png$/i.test(name)) fileMap.set(name, data);
        }
      } else {
        const jsonFile = array.find((file) => /\.json$/i.test(file.name));
        if (!jsonFile) {
          throw new Error('请同时选择图集 JSON 和对应的 PNG 页面。也可以直接导入之前导出的 ZIP。');
        }
        jsonData = new Uint8Array(await jsonFile.arrayBuffer());
        baseName = jsonFile.name.replace(/\.json$/i, '');
        for (const file of array) {
          if (/\.png$/i.test(file.name)) fileMap.set(file.name, new Uint8Array(await file.arrayBuffer()));
        }
      }

      setBusyProgress(24, '解析位置数据…');
      const decoded = zipDecoder.decode(jsonData).replace(/^\uFEFF/, '');
      let json;
      try {
        json = JSON.parse(decoded);
      } catch (error) {
        throw new Error('图集 JSON 不是有效的 JSON 文件。');
      }
      if (!json || !json.atlas || !Array.isArray(json.pages) || !Array.isArray(json.sequences)) {
        throw new Error('JSON 格式不符合本工具的图集结构（缺少 atlas / pages / sequences）。');
      }

      const width = Number(json.atlas.width);
      const height = Number(json.atlas.height);
      const rows = Number(json.atlas.rows);
      const cols = Number(json.atlas.cols);
      if (![width, height, rows, cols].every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error('图集尺寸或行列信息无效。');
      }
      if (width > MAX_CANVAS || height > MAX_CANVAS || rows > 64 || cols > 64) {
        throw new Error('图集尺寸或行列数超出支持范围。');
      }
      const config = {
        width,
        height,
        rows,
        cols,
        cellWidth: Math.floor(width / cols),
        cellHeight: Math.floor(height / rows)
      };
      if (config.cellWidth < 8 || config.cellHeight < 8) {
        throw new Error('图集单格尺寸小于 8 × 8 px，无法继续。');
      }
      if (!json.pages.length) throw new Error('JSON 中没有图集页面。');

      const pages = [];
      for (let index = 0; index < json.pages.length; index++) {
        const pageMeta = json.pages[index] || {};
        const fileName = pageMeta.file || `${baseName}_${pad2(index + 1)}.png`;
        const data = findZipEntry(fileMap, fileName) || findZipEntry(fileMap, `atlas_${pad2(index + 1)}.png`);
        if (!data) throw new Error(`缺少页面图片：${fileName}`);
        setBusyProgress(24 + ((index + 1) / json.pages.length) * 42, `读取页面 ${index + 1} / ${json.pages.length}…`);
        const blob = new Blob([data], { type: 'image/png' });
        const image = await decodeImageBlob(blob);
        if (image.width !== width || image.height !== height) {
          throw new Error(`页面 ${index + 1} 的尺寸是 ${image.width} × ${image.height}，与 JSON 中的 ${width} × ${height} 不一致。`);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        pages.push({ canvas, occupied: new Map(), previewURL: '' });
        if (image.close) image.close();
      }

      setBusyProgress(72, '恢复序列信息…');
      const sequences = [];
      for (let seqIndex = 0; seqIndex < json.sequences.length; seqIndex++) {
        const raw = json.sequences[seqIndex] || {};
        if (!Array.isArray(raw.frames) || !raw.frames.length) {
          throw new Error(`序列「${raw.name || seqIndex + 1}」没有帧数据。`);
        }
        const frames = raw.frames.map((rawFrame, frameIndex) => {
          const page = Number(rawFrame.page || 1);
          const row = Number(rawFrame.row ?? rawFrame.startRow);
          const col = Number(rawFrame.col ?? rawFrame.startCol);
          if (!Number.isInteger(page) || page < 1 || page > pages.length) {
            throw new Error(`序列「${raw.name || seqIndex + 1}」第 ${frameIndex + 1} 帧页码无效。`);
          }
          if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || row > rows || col < 1 || col > cols) {
            throw new Error(`序列「${raw.name || seqIndex + 1}」第 ${frameIndex + 1} 帧行列无效。`);
          }
          const x = Number.isFinite(Number(rawFrame.x)) ? Number(rawFrame.x) : (col - 1) * config.cellWidth;
          const y = Number.isFinite(Number(rawFrame.y)) ? Number(rawFrame.y) : (row - 1) * config.cellHeight;
          const frameWidth = Number(rawFrame.width) || config.cellWidth;
          const frameHeight = Number(rawFrame.height) || config.cellHeight;
          return {
            index: frameIndex,
            sourceIndex: rawFrame.sourceIndex ?? null,
            time: Number(rawFrame.time) || 0,
            page,
            row,
            col,
            x,
            y,
            width: frameWidth,
            height: frameHeight,
            label: rawFrame.label || `${raw.name || 'sequence'}_${pad3(frameIndex)}`
          };
        });
        frames.forEach((frame, frameIndex) => {
          pages[frame.page - 1].occupied.set(`${frame.row},${frame.col}`, {
            sequence: raw.name || `序列 ${seqIndex + 1}`,
            frame: frameIndex
          });
        });
        const first = frames[0];
        const last = frames[frames.length - 1];
        sequences.push({
          name: String(raw.name || `序列 ${seqIndex + 1}`),
          color: normalizeHex(raw.color) || SEQ_COLORS[seqIndex % SEQ_COLORS.length],
          source: String(raw.source || ''),
          frameCount: frames.length,
          frames,
          start: { page: first.page, row: first.row, col: first.col },
          end: { page: last.page, row: last.row, col: last.col },
          thumbs: []
        });
      }

      let nextCell = 0;
      const capacity = rows * cols;
      sequences.forEach((sequence) => {
        sequence.frames.forEach((frame) => {
          const global = (frame.page - 1) * capacity + (frame.row - 1) * cols + (frame.col - 1);
          nextCell = Math.max(nextCell, global + 1);
        });
      });

      const rawName = json.atlas && typeof json.atlas.name === 'string' ? json.atlas.name : '';
      const fallbackName = baseName && baseName.split('/').pop().toLowerCase() !== 'atlas'
        ? baseName.split('/').pop()
        : '';
      const importedName = normalizeAtlasName(rawName || fallbackName);

      state.atlas = { name: importedName, config, pages, sequences, nextCell };
      syncAtlasNameUI();
      els.atlasWidthInput.value = width;
      els.atlasHeightInput.value = height;
      els.rowsInput.value = rows;
      els.colsInput.value = cols;
      syncGridReadout();
      syncSettingsLock();

      stopPlayback();
      state.track = [];
      state.current = -1;
      renderTrack();
      updateSelectionUI();
      syncPreviewUI();
      drawPreview();

      setBusyProgress(88, '生成页面预览…');
      refreshPagePreviews();
      sequences.forEach((sequence) => { sequence.thumbs = buildSequenceThumbs(sequence); });
      renderAtlasPanel();
      syncAtlasDependentUI();
      activateTab('atlas');
      els.sequenceName.value = defaultSequenceName();
      hideBusy();
      showToast(`已导入 ${pages.length} 页 · ${sequences.length} 个序列，可继续追加`, 'ok', 4200);
    } catch (error) {
      hideBusy();
      console.error(error);
      showErrorModal('导入图集失败', error.message || '无法读取该图集。');
    }
  }

  function findZipEntry(map, name) {
    if (map.has(name)) return map.get(name);
    const base = String(name).split('/').pop();
    for (const [key, value] of map.entries()) {
      if (key.split('/').pop() === base) return value;
    }
    return null;
  }

  async function decodeImageBlob(blob) {
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(blob);
      } catch (error) {
        /* Fall back to an <img> decoder. */
      }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('PNG 页面解码失败。'));
      };
      image.src = url;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Page modal                                                          */
  /* ------------------------------------------------------------------ */

  function openPageModal(index) {
    const page = state.atlas.pages[index];
    if (!page || !state.atlas.config) return;
    const config = state.atlas.config;
    const preview = makePagePreview(page, 1400);
    const modal = openModal({
      title: `页面 ${index + 1}`,
      subtitle: `${config.width} × ${config.height} px · ${page.occupied.size} / ${config.rows * config.cols} 格已使用`,
      wide: true,
      body: `
        <div class="page-lightbox">
          <img src="${preview.toDataURL('image/png')}" alt="图集页面 ${index + 1}">
        </div>
        <div class="modal-note">棋盘格区域为透明像素。网格线仅用于查看，不会写入导出的 PNG。</div>`,
      footer: `<button class="btn btn-primary" type="button" data-close>关闭</button>`
    });
    return modal;
  }

  /* ------------------------------------------------------------------ */
  /* ZIP writer / reader                                                 */
  /* ------------------------------------------------------------------ */

  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }

  function crc32(data) {
    const table = getCrcTable();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime() {
    const date = new Date();
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = (year - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate();
    return { time, date: day };
  }

  function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const stamp = dosDateTime();

    for (const entry of entries) {
      const nameBytes = zipEncoder.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      localOffset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const centralOffset = localOffset;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    const total = localOffset + centralSize + eocd.length;
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of localParts) {
      output.set(part, offset);
      offset += part.length;
    }
    for (const part of centralParts) {
      output.set(part, offset);
      offset += part.length;
    }
    output.set(eocd, offset);
    return output;
  }

  async function readZipBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const minOffset = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
      if (view.getUint32(offset, true) === 0x06054B50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录结尾）。');

    const totalEntries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (centralOffset + centralSize > bytes.length) throw new Error('ZIP 目录数据损坏。');

    const entries = new Map();
    let pointer = centralOffset;
    for (let index = 0; index < totalEntries; index++) {
      if (view.getUint32(pointer, true) !== 0x02014B50) throw new Error('ZIP 中央目录损坏。');
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const uncompressedSize = view.getUint32(pointer + 24, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = zipDecoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

      if (view.getUint32(localOffset, true) !== 0x04034B50) throw new Error('ZIP 文件头损坏。');
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);

      let data;
      if (method === 0) {
        data = compressed;
      } else if (method === 8) {
        data = await inflateRaw(compressed);
        if (uncompressedSize && data.length !== uncompressedSize) {
          throw new Error(`ZIP 条目「${name}」解压后大小不一致。`);
        }
      } else {
        throw new Error(`不支持 ZIP 压缩方式 ${method}，请解压后导入 JSON + PNG。`);
      }
      entries.set(name, data);
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('浏览器不支持解压该 ZIP，请解压后导入图集 JSON 与 PNG。');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  /* ------------------------------------------------------------------ */
  /* Modal / busy                                                        */
  /* ------------------------------------------------------------------ */

  function openModal(options) {
    hideFramePeek(true);
    const { title, subtitle = '', body = '', footer = '', wide = false, onClose = null } = options;
    const root = els.modalRoot;
    root.innerHTML = `
      <div class="modal-backdrop" data-close></div>
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-head">
          <div>
            <h3>${escapeHtml(title)}</h3>
            ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
          </div>
          <button class="icon-btn modal-close" type="button" data-close title="关闭">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    root.classList.add('open');

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      root.classList.remove('open');
      root.innerHTML = '';
      document.removeEventListener('keydown', onKeyDown);
      if (onClose) onClose();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }
    root.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', close));
    onGlobal(document, 'keydown', onKeyDown);
    setTimeout(() => {
      const focusTarget = root.querySelector('input, .modal-foot .btn-primary, .modal-foot .btn, .modal-close');
      if (focusTarget) focusTarget.focus();
    }, 40);
    return { root, close, body: root.querySelector('.modal-body'), footer: root.querySelector('.modal-foot') };
  }

  function confirmDialog(options) {
    return new Promise((resolve) => {
      let settled = false;
      const modal = openModal({
        title: options.title,
        subtitle: options.message || '',
        body: '',
        footer: `
          <button class="btn btn-ghost" type="button" data-close>取消</button>
          <button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" type="button" data-confirm>${escapeHtml(options.confirmText || '确定')}</button>`,
        onClose: () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }
      });
      const confirmButton = modal.root.querySelector('[data-confirm]');
      if (confirmButton) {
        confirmButton.addEventListener('click', () => {
          if (settled) return;
          settled = true;
          modal.close();
          resolve(true);
        });
      }
    });
  }

  function showErrorModal(title, message) {
    const modal = openModal({
      title,
      subtitle: '请检查文件后重试。',
      body: '<div class="error-detail"></div>',
      footer: '<button class="btn btn-primary" type="button" data-close>知道了</button>'
    });
    const detail = modal.body.querySelector('.error-detail');
    if (detail) detail.textContent = message;
  }

  function showBusy(title, subtitle) {
    stopPlayback();
    state.busy.active = true;
    els.busyTitle.textContent = title;
    els.busySub.textContent = subtitle || '请稍候…';
    els.busyBar.style.width = '0%';
    els.busyCancelBtn.hidden = true;
    els.busyCancelBtn.disabled = false;
    state.busy.cancel = null;
    els.progressOverlay.hidden = false;
  }

  function setBusyProgress(percent, subtitle) {
    els.busyBar.style.width = `${clamp(percent, 0, 100)}%`;
    if (subtitle) els.busySub.textContent = subtitle;
  }

  function hideBusy() {
    els.progressOverlay.hidden = true;
    state.busy.active = false;
    state.busy.cancel = null;
    els.busyCancelBtn.hidden = true;
    els.busyCancelBtn.disabled = false;
  }

  function openHelpModal() {
    openModal({
      title: '使用说明',
      subtitle: '从视频到透明序列帧图集，只要五步。',
      wide: true,
      body: `
        <div class="help-content">
          <ol class="help-steps">
            <li><strong>导入视频并提取帧</strong><span>设置 FPS 与起止时间。提取后会按时间顺序显示源帧缩略图；鼠标悬停在缩略图上可查看固定位置的大图、帧号、时间与原始分辨率，方便连续对比。</span></li>
            <li><strong>选择并排序</strong><span>点击缩略图加入轨道，再次点击取消。轨道顺序就是播放顺序；拖动卡片或使用卡片底部的箭头调整。</span></li>
            <li><strong>预览</strong><span>空格播放 / 暂停，← → 单帧步进。可切换循环播放，预览帧率可单独设置。</span></li>
            <li><strong>设置画布与透明背景</strong><span>在右侧设置 PNG 尺寸与行列。视频本身没有透明通道，开启「透明背景」并用取色按钮选取背景色，即可输出透明 PNG。</span></li>
            <li><strong>追加并导出</strong><span>给序列命名后点击「追加到图集」。可继续导入其他视频，把战斗、跑步等序列追加到同一图集。容量不足自动翻页，序列会尽量保持在同一页。在「图集」页签填写图集名称后，导出的 PNG、JSON 与 ZIP 会使用该名称。每个序列右侧的删除按钮可在确认后移除序列，并自动向前重排剩余序列。</span></li>
          </ol>
          <h4>图集命名</h4>
          <p>在「图集」页签顶部填写名称，例如「角色战斗图集」。命名后 ZIP 为 <code>角色战斗图集_时间戳.zip</code>，内部页面为 <code>角色战斗图集_01.png</code>，位置数据为 <code>角色战斗图集.json</code>。留空时沿用 <code>atlas_01.png</code> / <code>atlas.json</code>。重新导入时会恢复名称。</p>
          <h4>缩放与位置</h4>
          <p>每帧按「单格尺寸」等比缩放并居中，绝不拉伸变形。图集位置以<strong>从 1 开始的行列</strong>记录；JSON 同时包含页面、像素区域与序列起止行列。</p>
          <h4>继续追加以前导出的图集</h4>
          <p>导入之前导出的 ZIP，或同时选择图集 JSON 与所有页面 PNG。工具会恢复页面、占用格子、序列与图集名称，然后从已有内容之后继续追加。</p>
          <h4>图集 JSON 结构（节选）</h4>
          <pre class="json-example">{
  "atlas": { "name": "角色战斗图集",
             "width": 2048, "height": 2048,
             "rows": 4, "cols": 4,
             "cellWidth": 512, "cellHeight": 512,
             "pageCount": 1 },
  "sequences": [{
    "name": "run",
    "start": { "page": 1, "row": 1, "col": 1 },
    "end":   { "page": 1, "row": 2, "col": 4 },
    "startRow": 1, "startCol": 1,
    "endRow": 2, "endCol": 4,
    "frames": [{
      "index": 0, "page": 1, "row": 1, "col": 1,
      "x": 0, "y": 0, "width": 512, "height": 512
    }]
  }]
}</pre>
          <div class="help-tip">
            <svg class="icon"><use href="#i-info"/></svg>
            <span>行列从 1 开始。若一个序列跨页，start / end 会包含不同页码；单页足够时，序列不会被拆开。</span>
          </div>
        </div>`,
      footer: '<button class="btn btn-primary" type="button" data-close>开始使用</button>'
    });
  }

  /* ------------------------------------------------------------------ */
  /* Drag & drop and keyboard                                            */
  /* ------------------------------------------------------------------ */

  function onWindowDragEnter(event) {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    els.dropOverlay.hidden = false;
  }

  function onWindowDragOver(event) {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onWindowDragLeave(event) {
    if (!event.dataTransfer) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropOverlay.hidden = true;
  }

  function onWindowDrop(event) {
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    if (state.busy.active || state.extracting) {
      showToast('当前正在处理，请稍后再试。', 'warn');
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    if (!files.length) return;
    const video = files.find(isVideoFile);
    if (video) {
      loadVideoFile(video);
      return;
    }
    if (files.some((file) => /\.(zip|json|png)$/i.test(file.name))) {
      handleAtlasFiles(files);
      return;
    }
    showToast('无法识别拖入的文件。请拖入视频，或图集 ZIP / JSON + PNG。', 'warn');
  }

  function onGlobalKeyDown(event) {
    if (els.modalRoot.classList.contains('open')) return;
    if (state.busy.active || state.extracting || state.detecting) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target && (target.matches('input, textarea, select, button') || target.isContentEditable)) return;
    if (event.code === 'Space') {
      if (!state.track.length) return;
      event.preventDefault();
      togglePlayback();
    } else if (event.key === 'ArrowLeft') {
      if (!state.track.length) return;
      event.preventDefault();
      stopPlayback();
      stepFrame(-1);
    } else if (event.key === 'ArrowRight') {
      if (!state.track.length) return;
      event.preventDefault();
      stopPlayback();
      stepFrame(1);
    } else if (event.key === 'Home') {
      if (!state.track.length) return;
      event.preventDefault();
      stopPlayback();
      setCurrent(0, true);
    } else if (event.key === 'End') {
      if (!state.track.length) return;
      event.preventDefault();
      stopPlayback();
      setCurrent(state.track.length - 1, true);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.current < 0) return;
      event.preventDefault();
      removeTrackAt(state.current);
    }
  }
  window.MiraSpriteForge = {
    boot: init,
    destroy() {
      try {
        stopPlayback();
      } catch (error) {
        console.error(error);
      }
      for (const [target, type, handler, options] of hostListeners.splice(0)) {
        target.removeEventListener(type, handler, options);
      }
    },
    importFile(kind, file) {
      return injectFile(kind, file);
    },
    // 给自动化和排查用：一眼看到载入状态（不影响界面）。
    snapshot() {
      return {
        duration: state.duration,
        videoName: state.videoFile ? state.videoFile.name : null,
        frames: state.frames.length,
        track: state.track.length,
        playing: state.playing,
        current: state.current,
        atlasPages: state.atlas.pages.length,
        atlasCells: state.atlas.pages.reduce((total, page) => total + (page.used || 0), 0),
      };
    },
  };
})();
