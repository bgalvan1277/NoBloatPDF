// No Bloat PDF — Tauri glue + tab manager. Loaded before viewer.mjs; both are
// ES modules, so this runs first and can register the webviewerloaded hook.
// Requires app.withGlobalTauri = true (no bundler, no npm runtime deps).
//
// Tab model: ONE pdf.js viewer instance; switching tabs closes/reopens the
// document. pdf.js ViewHistory (localStorage, keyed by file fingerprint)
// restores page/zoom/scroll per document, so switches come back to where you
// left off without us tracking view state.

const { core, event: tauriEvent, webview, window: tauriWindow } = window.__TAURI__;

document.addEventListener('webviewerloaded', () => {
  const opts = window.PDFViewerApplicationOptions;
  opts.set('defaultUrl', ''); // never load the bundled Mozilla demo document
  opts.set('enableScripting', false); // PDF-embedded JS sandbox: off (speed, size, scope)
  opts.set('printResolution', 300);
});

// ---------------------------------------------------------------------------
// Tabs

const tabs = []; // { id, path, name }
let activeTabId = null;
let tabSeq = 0;

// All viewer document operations (open/close) run through this queue, one at
// a time. Each task re-checks activeTabId when it actually runs, so stale
// switches become no-ops instead of racing pdf.js's single-document viewer
// (whose load() has no stale-task guard of its own).
let viewerOp = Promise.resolve();
function queueViewerOp(task) {
  const run = viewerOp.then(task, task);
  viewerOp = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Tab identity: Windows paths (drive letter or UNC) are case-insensitive and
// slash-tolerant; POSIX paths are compared as-is (case-sensitive volumes).
function normPath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
    ? p.replace(/\//g, '\\').toLowerCase()
    : p;
}

function baseName(p) {
  return p.replace(/^.*[\\/]/, '');
}

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) ?? null;
}

// pdf.js owns document.title (it rewrites it on every open); the native
// window title is ours alone, so only that is set here.
let lastTitle = null;
function setWindowTitle(text) {
  if (text === lastTitle) return;
  lastTitle = text;
  tauriWindow.getCurrentWindow().setTitle(text).catch(() => {});
}

function updateChrome() {
  renderTabBar();
  const tab = activeTab();
  setWindowTitle(tab ? `${tab.name} — No Bloat PDF` : 'No Bloat PDF');
  document.getElementById('nobloatEmptyState')?.classList.toggle('hidden', tabs.length > 0);
}

function activateTab(id, { reload = false } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const alreadyActive = activeTabId === id;
  if (alreadyActive && !reload) return;
  if (!alreadyActive) {
    activeTabId = id;
    updateChrome();
  }
  queueViewerOp(async () => {
    if (activeTabId !== id) return; // superseded while queued
    const app = window.PDFViewerApplication;
    await app.initializedPromise;
    if (activeTabId !== id) return;
    try {
      // open() closes any current document first; ViewHistory restores the
      // previous page/zoom for this file automatically (viewOnLoad = previous).
      await app.open({ url: core.convertFileSrc(tab.path) });
    } catch (err) {
      // This pdf.js build surfaces no error UI of its own (documenterror has
      // no listener). Keep the tab; tell the user what happened.
      console.error('No Bloat PDF: failed to open', tab.path, err);
      window.__TAURI__.dialog
        .message(`Couldn't open ${tab.name}.\n\n${err?.message ?? err}`, {
          title: 'No Bloat PDF',
          kind: 'error',
        })
        .catch(() => {});
    }
  });
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (activeTabId !== id) {
    updateChrome();
    return;
  }
  if (tabs.length > 0) {
    // Prefer the tab that slides into the closed tab's position.
    activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
    return;
  }
  activeTabId = null;
  updateChrome();
  queueViewerOp(async () => {
    if (activeTabId !== null) return; // a newer open superseded this close
    const app = window.PDFViewerApplication;
    await app.initializedPromise;
    if (activeTabId !== null) return;
    try {
      await app.close();
    } catch {
      /* nothing to close */
    }
  });
}

// Opens every PDF in `paths` as a tab (existing tabs are reused) and
// activates the last one. An explicit re-open of the already-active file
// reloads it from disk (the file may have changed externally).
function openPaths(paths) {
  const pdfs = (paths ?? []).filter((p) => typeof p === 'string' && p.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) return;
  let last = null;
  for (const path of pdfs) {
    const key = normPath(path);
    let tab = tabs.find((t) => normPath(t.path) === key);
    if (!tab) {
      tab = { id: ++tabSeq, path, name: baseName(path) };
      tabs.push(tab);
    }
    last = tab;
  }
  activateTab(last.id, { reload: true });
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  activateTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
}

async function pickAndOpen() {
  const picked = await window.__TAURI__.dialog.open({
    multiple: true,
    directory: false,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!picked) return;
  openPaths(Array.isArray(picked) ? picked : [picked]);
}

// ---------------------------------------------------------------------------
// Tab bar UI

function renderTabBar() {
  const bar = document.getElementById('nobloatTabBar');
  if (!bar) return;
  bar.textContent = '';

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'nb-tab' + (tab.id === activeTabId ? ' nb-active' : '');
    el.title = tab.path;
    el.addEventListener('click', () => activateTab(tab.id));
    el.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) closeTab(tab.id);
    });

    const name = document.createElement('span');
    name.className = 'nb-tab-name';
    name.textContent = tab.name;

    const close = document.createElement('button');
    close.className = 'nb-tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${tab.name}`);
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTab(tab.id);
    });

    el.append(name, close);
    bar.append(el);
  }

  const add = document.createElement('button');
  add.className = 'nb-tab-add';
  add.type = 'button';
  add.textContent = '+';
  add.title = 'Open PDF (Ctrl+O)';
  add.setAttribute('aria-label', 'Open PDF');
  add.addEventListener('click', pickAndOpen);
  bar.append(add);
}

// ---------------------------------------------------------------------------
// Wiring

window.addEventListener('DOMContentLoaded', () => {
  // Tab strip above the viewer chrome (body is turned into a flex column in
  // nobloat.css; #outerContainer flexes to fill the rest).
  const tabBar = document.createElement('div');
  tabBar.id = 'nobloatTabBar';
  document.body.insertBefore(tabBar, document.getElementById('outerContainer'));

  // Branded empty state until the first document opens; pointer-events: none
  // in nobloat.css keeps drops and clicks working through it.
  const mainContainer = document.getElementById('mainContainer');
  if (mainContainer) {
    const empty = document.createElement('div');
    empty.id = 'nobloatEmptyState';
    const img = document.createElement('img');
    img.src = '../brand/icon.png';
    img.alt = '';
    const title = document.createElement('div');
    title.className = 'nb-title';
    title.textContent = 'No Bloat PDF';
    const hint = document.createElement('div');
    hint.className = 'nb-hint';
    hint.textContent = 'Drop a PDF here, or press Ctrl+O to open';
    empty.append(img, title, hint);
    mainContainer.append(empty);
  }

  // "About" entry at the bottom of the secondary (») toolbar menu.
  const menu = document.getElementById('secondaryToolbarButtonContainer');
  if (menu) {
    const about = document.createElement('button');
    about.className = 'secondaryToolbarButton';
    about.type = 'button';
    const label = document.createElement('span');
    label.textContent = 'About No Bloat PDF';
    about.append(label);
    about.addEventListener('click', () => core.invoke('show_about').catch(() => {}));
    menu.append(about);
  }

  renderTabBar();

  // Warm start: Rust forwards paths from a second app instance.
  tauriEvent.listen('open-file', (e) => openPaths(e.payload));

  // Native drag-and-drop delivers OS paths; the viewer's HTML5 drop handler
  // never fires on Windows while Tauri's dragDropEnabled (default) is on.
  webview.getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === 'drop') openPaths(e.payload.paths);
  });

  // Cold start: drain paths buffered from argv (Windows) / RunEvent::Opened (macOS).
  core.invoke('pending_files').then(openPaths).catch(() => {});

  // Replace the viewer's HTML5 <input type=file> open flow with the native
  // dialog so we always work with real filesystem paths.
  for (const id of ['openFile', 'secondaryOpenFile']) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener(
        'click',
        (ev) => {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          pickAndOpen();
        },
        { capture: true }
      );
    }
  }

  window.addEventListener(
    'keydown',
    (ev) => {
      const plainCtrl = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey;
      let action = null;
      if (plainCtrl && ev.key.toLowerCase() === 'o') {
        action = pickAndOpen;
      } else if (plainCtrl && ev.key.toLowerCase() === 'w') {
        action = () => activeTabId !== null && closeTab(activeTabId);
      } else if (ev.ctrlKey && !ev.altKey && ev.key === 'Tab') {
        action = () => cycleTab(ev.shiftKey ? -1 : 1);
      }
      if (!action) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      action();
    },
    { capture: true }
  );
});
