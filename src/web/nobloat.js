// No Bloat PDF — Tauri glue + tab manager. Loaded before viewer.mjs; both are
// ES modules, so this runs first and can register the webviewerloaded hook.
// Requires app.withGlobalTauri = true (no bundler, no npm runtime deps).
//
// Tab model: ONE pdf.js viewer instance; switching tabs closes/reopens the
// document. pdf.js ViewHistory (localStorage, keyed by file fingerprint)
// restores page/zoom/scroll per document, so switches come back to where you
// left off without us tracking view state.

const { core, event: tauriEvent, webview, window: tauriWindow } = window.__TAURI__;

const isMac = navigator.platform.startsWith('Mac');

// Menu/tooltip shortcut text only — key handlers already accept Ctrl and Cmd.
function shortcutLabel(win) {
  if (!isMac) return win;
  return win.replace(/Ctrl\+Shift\+/g, '⇧⌘').replace(/Ctrl\+/g, '⌘');
}

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
  const star = tab?.bookmarksDirty ? '* ' : '';
  setWindowTitle(tab ? `${star}${tab.name} — No Bloat PDF` : 'No Bloat PDF');
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

async function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.bookmarksDirty && (tab.bookmarks?.length || tab.deletedOutline?.length)) {
    let ok = true;
    try {
      ok = await window.__TAURI__.dialog.confirm(
        `"${tab.name}" has bookmark changes that were not saved into the PDF. Close anyway?`,
        { title: 'No Bloat PDF', kind: 'warning' }
      );
    } catch {
      /* dialog unavailable: close without blocking */
    }
    if (!ok) return;
  }
  // Recompute after the await: tabs may have changed while the dialog was open.
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
// Bookmarks
//
// Each tab carries the session's outline edits: `tab.bookmarks` is a list of
// added bookmarks ({ title, pageIndex, left, top }) and `tab.deletedOutline`
// is a list of index paths into the document's ORIGINAL outline (e.g. [2, 1]
// = second child of the third top-level item) marking existing bookmarks the
// user deleted. On save, viewer.mjs fetches both through
// window.nobloatBookmarks.saveOptions() and the pdf.js worker rewrites the
// outline accordingly, so the changes persist in the file and show up in
// Adobe and every other reader. Saving always rebuilds from the original
// bytes, so the full edit set is applied on every save and stays editable in
// between.

const SIDEBAR_VIEW_OUTLINE = 2; // pdf.js SidebarView.OUTLINE

window.nobloatBookmarks = {
  saveOptions() {
    const tab = activeTab();
    const newOutline = tab?.bookmarks?.length
      ? tab.bookmarks.map(({ title, pageIndex, left, top }) => ({ title, pageIndex, left, top }))
      : null;
    const deleteOutline = tab?.deletedOutline?.length
      ? tab.deletedOutline.map((path) => path.slice())
      : null;
    return newOutline || deleteOutline ? { newOutline, deleteOutline } : null;
  },
};

// Re-entrancy: our own render() below re-fires pdf.js's outlineloaded event.
let suppressOutlineLoaded = false;
let outlineRenderToken = 0;

// Unsaved bookmark edits are surfaced in the window title (leading *), as a
// dot on the tab, and as the in-panel save bar; cleared when a save goes
// through, the file reloads, or every edit has been undone.
function markBookmarksDirty(tab) {
  tab.bookmarksDirty = !!(tab.bookmarks?.length || tab.deletedOutline?.length);
  updateChrome();
}

// Renders the document's own outline (minus deleted items) plus this tab's
// added bookmarks as one tree, then decorates every bookmark row with its
// controls (delete on all rows, rename on the session's new ones).
async function renderMergedOutline() {
  const app = window.PDFViewerApplication;
  const doc = app?.pdfDocument;
  const viewer = app?.pdfOutlineViewer;
  const tab = activeTab();
  if (!doc || !viewer || !tab) return;
  const token = ++outlineRenderToken;
  const pending = tab.bookmarks ?? [];
  let outline;
  try {
    outline = (await doc.getOutline()) ?? [];
  } catch {
    outline = [];
  }
  // Deletions are recorded as index paths into the ORIGINAL outline (that is
  // also what the worker walks on save). Prune them from the display and keep
  // a parallel tree of original paths for the delete buttons.
  const deleted = new Set((tab.deletedOutline ?? []).map((path) => path.join('.')));
  const pruneLevel = (levelItems, basePath) => {
    const rendered = [];
    const meta = [];
    (levelItems ?? []).forEach((item, i) => {
      const path = basePath.concat(i);
      if (deleted.has(path.join('.'))) return;
      const sub = pruneLevel(item.items, path);
      rendered.push({ ...item, items: sub.rendered });
      meta.push({ path, children: sub.meta });
    });
    return { rendered, meta };
  };
  const existing = pruneLevel(outline, []);
  const items = [];
  for (const bm of pending) {
    let dest = null;
    try {
      const page = await doc.getPage(bm.pageIndex + 1);
      dest = [page.ref, { name: 'XYZ' }, bm.left ?? null, bm.top ?? null, null];
    } catch {
      /* page unavailable: render the row without a link */
    }
    items.push({
      title: bm.title || `Page ${bm.pageIndex + 1}`,
      dest,
      url: null,
      items: [],
      bold: false,
      italic: false,
      color: null,
    });
  }
  // A tab switch or a newer render may have superseded this one while awaiting.
  if (token !== outlineRenderToken || doc !== app.pdfDocument) return;
  // render() resets per-document state the viewer only learns from events that
  // already fired (pagesloaded, pagechanging); carry it across.
  const pagesLoaded = viewer._isPagesLoaded;
  const currentPage = viewer._currentPageNumber;
  suppressOutlineLoaded = true;
  try {
    viewer.render({ outline: existing.rendered.concat(items), pdfDocument: doc });
  } finally {
    suppressOutlineLoaded = false;
  }
  viewer._isPagesLoaded = pagesLoaded;
  viewer._currentPageNumber = currentPage;
  if (pagesLoaded) viewer._currentOutlineItemCapability?.resolve(true);
  decorateOutlineRows(tab, existing.meta, items.length);
}

// The bookmark rows are the last `count` top-level items in the outline tree
// (they were concat'ed after the document's own outline).
function bookmarkRows(count) {
  const container = document.getElementById('outlinesView');
  if (!container || count <= 0) return [];
  return [...container.children].filter((el) => el.classList.contains('treeItem')).slice(-count);
}

function makeRowButton(glyph, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = glyph;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return btn;
}

function attachRowControls(row, buttons) {
  row.classList.add('nb-bookmark');
  const controls = document.createElement('span');
  controls.className = 'nb-bm-controls';
  controls.append(...buttons);
  row.append(controls);
}

// Existing bookmarks (the document's own outline) get a delete button at any
// nesting depth; deleting one removes it and its sub-bookmarks on save.
function decorateExistingLevel(tab, rowEls, metas) {
  metas.forEach((meta, i) => {
    const row = rowEls[i];
    if (!row) return;
    attachRowControls(row, [
      makeRowButton('×', 'Delete bookmark (removed from the PDF when you save)', () => {
        (tab.deletedOutline ??= []).push(meta.path);
        markBookmarksDirty(tab);
        renderMergedOutline();
      }),
    ]);
    if (meta.children.length) {
      const wrap = row.querySelector(':scope > .treeItems');
      const childRows = wrap ? [...wrap.children].filter((el) => el.classList.contains('treeItem')) : [];
      decorateExistingLevel(tab, childRows, meta.children);
    }
  });
}

function decorateOutlineRows(tab, existingMeta, pendingCount) {
  const container = document.getElementById('outlinesView');
  if (!container) return;
  // In-panel add button, pinned above the bookmark rows.
  const addRow = document.createElement('div');
  addRow.id = 'nbAddBookmarkRow';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = '+ Add bookmark for this page';
  addBtn.title = 'Bookmark the page you are viewing (Ctrl+B)';
  addBtn.addEventListener('click', addBookmark);
  addRow.append(addBtn);
  container.prepend(addRow);
  // Explicit save button whenever there are unsaved bookmark changes, right
  // where the user just made them.
  if (tab.bookmarksDirty) {
    const saveRow = document.createElement('div');
    saveRow.id = 'nbSaveBookmarksRow';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save changes to PDF';
    saveBtn.title = 'Write your bookmark changes into the PDF file';
    saveBtn.addEventListener('click', () => {
      window.PDFViewerApplication?.eventBus?.dispatch('download', { source: saveBtn });
    });
    saveRow.append(saveBtn);
    container.prepend(saveRow);
  }
  const rows = [...container.children].filter((el) => el.classList.contains('treeItem'));
  decorateExistingLevel(tab, rows.slice(0, existingMeta.length), existingMeta);
  const pendingRows = pendingCount > 0 ? rows.slice(-pendingCount) : [];
  pendingRows.forEach((row, i) => {
    const link = row.querySelector(':scope > a');
    if (link) link.title = 'Bookmark: written into the PDF when you save';
    attachRowControls(row, [
      makeRowButton('✎', 'Rename bookmark', () => beginBookmarkRename(tab, i)),
      makeRowButton('×', 'Delete bookmark', () => {
        tab.bookmarks.splice(i, 1);
        markBookmarksDirty(tab);
        renderMergedOutline();
      }),
    ]);
  });
}

// Swaps the bookmark's link for a text input; Enter/blur commits, Esc cancels.
// window.prompt() is unavailable in the Tauri webview, hence inline editing.
function beginBookmarkRename(tab, index) {
  const rows = bookmarkRows(tab.bookmarks.length);
  const row = rows[index];
  const link = row?.querySelector(':scope > a');
  if (!link) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'nb-bm-input';
  input.value = tab.bookmarks[index].title;
  row.classList.add('nb-editing');
  link.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (keep) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (keep && value && value !== tab.bookmarks[index]?.title) {
      tab.bookmarks[index].title = value;
      markBookmarksDirty(tab);
    }
    renderMergedOutline();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit(true);
    else if (ev.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// Bookmarks the current view (page + scroll position, like Adobe) and opens
// the outline sidebar with the new entry ready to rename.
function addBookmark() {
  const app = window.PDFViewerApplication;
  const tab = activeTab();
  if (!tab || !app?.pdfDocument) return;
  const loc = app.pdfViewer?._location;
  const pageNumber = loc?.pageNumber ?? app.pdfViewer?.currentPageNumber ?? 1;
  (tab.bookmarks ??= []).push({
    title: `Page ${pageNumber}`,
    pageIndex: pageNumber - 1,
    left: typeof loc?.left === 'number' ? loc.left : null,
    top: typeof loc?.top === 'number' ? loc.top : null,
  });
  markBookmarksDirty(tab);
  app.viewsManager?.switchView(SIDEBAR_VIEW_OUTLINE, true);
  renderMergedOutline().then(() => beginBookmarkRename(tab, tab.bookmarks.length - 1));
}

// ---------------------------------------------------------------------------
// Saving
//
// viewer.mjs hands saved bytes to window.nobloatSaveFile instead of the
// browser download flow: native Save dialog defaulting to the tab's own
// file, atomic write through the save_pdf command, a toast on success, and
// a reload-from-disk when the tab's own file was overwritten so the viewer
// shows exactly what is now in the file.

let toastTimer = null;
function showToast(text) {
  let el = document.getElementById('nobloatToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nobloatToast';
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('nb-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('nb-show'), 3000);
}

window.nobloatSaveFile = async function (data, suggestedName) {
  const tab = activeTab();
  // File > Save presets the tab's own path; everything else asks where to save.
  const preset = directSaveTarget;
  directSaveTarget = null;
  const target =
    preset ??
    (await window.__TAURI__.dialog.save({
      defaultPath: tab?.path ?? suggestedName ?? 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }));
  if (!target) return false; // user cancelled the dialog
  const sameFile = tab && normPath(target) === normPath(tab.path);
  try {
    if (sameFile) {
      // pdf.js may still be range-reading this file from disk; close the
      // document before overwriting it. The tab reloads from the new bytes
      // below (the fingerprint change then retires the session's bookmark
      // edits, which are now part of the file itself).
      await queueViewerOp(async () => {
        const app = window.PDFViewerApplication;
        await app.initializedPromise;
        try {
          await app.close();
        } catch {
          /* nothing to close */
        }
      });
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await core.invoke('save_pdf', bytes, {
      headers: { 'x-save-path': encodeURIComponent(target) },
    });
  } catch (err) {
    console.error('No Bloat PDF: save failed', err);
    window.__TAURI__.dialog
      .message(`Couldn't save the PDF.\n\n${err?.message ?? err}`, {
        title: 'No Bloat PDF',
        kind: 'error',
      })
      .catch(() => {});
    if (sameFile) activateTab(tab.id, { reload: true }); // reopen what we closed
    return false;
  }
  showToast(`Saved ${baseName(target)}`);
  if (sameFile) {
    activateTab(tab.id, { reload: true });
  }
  return true;
};

// ---------------------------------------------------------------------------
// Menu bar (File / Tools / About)
//
// Classic menu strip above the tab bar. Item lists are rebuilt every time a
// menu opens so enabled/checked states are always current. The Tools menu
// mirrors the viewer's secondary (») toolbar: each entry proxies a click to
// the corresponding pdf.js button, so behavior, localized labels, and radio
// states stay in lockstep with the viewer's own controls.

let appVersion = '';

// File > Save: when set, nobloatSaveFile writes here instead of asking where
// to save. Consumed (and cleared) by the first save that follows.
let directSaveTarget = null;

function dispatchDownload() {
  window.PDFViewerApplication?.eventBus?.dispatch('download', { source: 'nobloatMenu' });
}

function saveActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  directSaveTarget = tab.path;
  dispatchDownload();
}

function saveActiveTabAs() {
  if (!activeTab()) return;
  directSaveTarget = null;
  dispatchDownload();
}

// [buttonId, English fallback]; null = separator. Labels are read from the
// live (l10n-filled) buttons at open time, so they match the app language.
const TOOLS_MENU = [
  ['presentationMode', 'Presentation Mode'],
  null,
  ['firstPage', 'Go to First Page'],
  ['lastPage', 'Go to Last Page'],
  null,
  ['pageRotateCw', 'Rotate Clockwise'],
  ['pageRotateCcw', 'Rotate Counterclockwise'],
  null,
  ['cursorSelectTool', 'Text Selection Tool'],
  ['cursorHandTool', 'Hand Tool'],
  null,
  ['scrollPage', 'Page Scrolling'],
  ['scrollVertical', 'Vertical Scrolling'],
  ['scrollHorizontal', 'Horizontal Scrolling'],
  ['scrollWrapped', 'Wrapped Scrolling'],
  null,
  ['spreadNone', 'No Spreads'],
  ['spreadOdd', 'Odd Spreads'],
  ['spreadEven', 'Even Spreads'],
  null,
  ['documentProperties', 'Document Properties…'],
];

function fileMenuItems() {
  const hasDoc = !!activeTab();
  return [
    { label: 'Open…', shortcut: shortcutLabel('Ctrl+O'), action: pickAndOpen },
    { type: 'separator' },
    { label: 'Save', shortcut: shortcutLabel('Ctrl+S'), enabled: hasDoc, action: saveActiveTab },
    {
      label: 'Save As…',
      shortcut: shortcutLabel('Ctrl+Shift+S'),
      enabled: hasDoc,
      action: saveActiveTabAs,
    },
    { type: 'separator' },
    {
      label: 'Print…',
      shortcut: shortcutLabel('Ctrl+P'),
      enabled: hasDoc,
      action: () => document.getElementById('printButton')?.click(),
    },
    { type: 'separator' },
    {
      label: 'Close Tab',
      shortcut: shortcutLabel('Ctrl+W'),
      enabled: hasDoc,
      action: () => activeTabId !== null && closeTab(activeTabId),
    },
    // close() runs the same unsaved-changes confirm as the window's X button.
    { label: 'Exit', action: () => tauriWindow.getCurrentWindow().close().catch(() => {}) },
  ];
}

function toolsMenuItems() {
  const hasDoc = !!window.PDFViewerApplication?.pdfDocument;
  return TOOLS_MENU.map((entry) => {
    if (!entry) return { type: 'separator' };
    const [id, fallback] = entry;
    const btn = document.getElementById(id);
    return {
      label: btn?.querySelector('span')?.textContent?.trim() || fallback,
      enabled: hasDoc && !!btn,
      checked: btn?.classList.contains('toggled') ?? false,
      action: () => btn?.click(),
    };
  });
}

function aboutMenuItems() {
  const openUrl = (url) => window.__TAURI__.opener.openUrl(url).catch(() => {});
  return [
    { label: 'About No Bloat PDF', action: showAboutDialog },
    { label: 'Special Thanks', action: showThanksDialog },
    { label: appVersion ? `Version ${appVersion}` : 'Version', enabled: false },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      action: () => openUrl('https://www.nobloatpdf.com/download.html'),
    },
    { type: 'separator' },
    { label: 'License Information', action: showLicenseDialog },
  ];
}

// ---------------------------------------------------------------------------
// About / Special Thanks / License modals
//
// All three live as centered <dialog>s inside the viewer window (the old
// separate About webview window is gone). Native <dialog> gives centering,
// Esc, and the dimmed backdrop for free; every modal also closes on a
// backdrop click because its padding lives on an inner box, so a click that
// lands on the dialog element itself can only be outside that box.

function createModal(id) {
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.className = 'nb-modal';
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  return dialog;
}

// The static content below is our own trusted markup (no user input).
let aboutDialog = null;

function showAboutDialog() {
  if (!aboutDialog) {
    aboutDialog = createModal('nbAboutDialog');
    aboutDialog.innerHTML = `
      <div class="nb-about-box">
        <header class="nb-about-hero">
          <img class="nb-about-wordmark" src="../brand/logo.png" alt="No Bloat — Simple Lightweight PDF Viewer" />
          <div class="nb-about-pills">
            <span class="nb-pill">Version <span id="nbAboutVersion"></span></span>
            <span class="nb-pill nb-pill-accent">Free · No tracking · No accounts</span>
          </div>
          <button type="button" class="nb-modal-x" aria-label="Close">×</button>
        </header>
        <div class="nb-about-body">
          <section class="nb-about-card">
            <div class="nb-about-label">Why this exists</div>
            <p>
              I built No Bloat PDF for a simple reason: I grew to hate opening
              Adobe PDFs. The most common file on a computer had somehow ended
              up behind slow launchers, ads, cloud upsells, and sign-in
              prompts. And everyone I talked to (in every kind of role,
              working day to day) was quietly putting up with the same thing.
            </p>
            <p>
              So I built the viewer I wanted: it opens instantly, stays out of
              your way, and never phones home. And I'm giving it away, because
              so many people deal with the same problems. No agenda. Nothing
              to sell.
            </p>
          </section>
          <section class="nb-about-card nb-about-author">
            <img class="nb-about-avatar" src="../brand/brian.png" alt="Brian Galvan" />
            <div>
              <div class="nb-about-name">Brian Galvan</div>
              <div class="nb-about-tagline">Lifelong developer &amp; Martech provider</div>
              <div class="nb-about-chips">
                <span class="nb-chip">Director of Growth &amp; Innovation · Barnes Walker</span>
                <span class="nb-chip">CTO &amp; Co-founder · Virtual Hangar</span>
                <span class="nb-chip">Owner · YourLegal.app</span>
              </div>
            </div>
          </section>
          <div class="nb-about-actions">
            <a href="#" id="nbAboutSite" class="nb-about-cta">Visit NoBloatPDF.com<span>updates &amp; new versions</span></a>
            <a href="#" id="nbAboutCoffee" class="nb-about-coffee" title="Buy me a coffee"><img src="../brand/buycoffee.png" alt="Buy me a coffee" /></a>
          </div>
          <footer>© 2026 Brian Galvan</footer>
        </div>
      </div>`;
    aboutDialog.querySelector('.nb-modal-x').addEventListener('click', () => aboutDialog.close());
    // External links must open in the system browser, never navigate the app.
    for (const [id, url] of [
      ['nbAboutSite', 'https://www.nobloatpdf.com'],
      ['nbAboutCoffee', 'https://buymeacoffee.com/briangalvan'],
    ]) {
      aboutDialog.querySelector(`#${id}`).addEventListener('click', (ev) => {
        ev.preventDefault();
        window.__TAURI__.opener.openUrl(url).catch(() => {});
      });
    }
  }
  aboutDialog.querySelector('#nbAboutVersion').textContent = appVersion || '';
  aboutDialog.showModal();
}

let thanksDialog = null;

function showThanksDialog() {
  if (!thanksDialog) {
    thanksDialog = createModal('nbThanksDialog');
    thanksDialog.innerHTML = `
      <div class="nb-thanks-box">
        <h2>Special Thanks</h2>
        <p>
          Thanks to the community of testers who gave me feedback over the
          first six months of building this. Special thanks to Tori Leidke and
          the attorneys at Barnes Walker Law Firm, whose insight helped me
          shape the final rounds into something solid.
        </p>
        <p>
          Our years long fight with Adobe, the daily slowdowns, the friction
          that quietly made everything harder, finally comes to an end. And it
          ends the way the best products do: through a community of volunteers
          who care about building simple tools that just work.
        </p>
        <div class="nb-modal-footer"><button type="button">Close</button></div>
      </div>`;
    thanksDialog.querySelector('.nb-modal-footer button').addEventListener('click', () => thanksDialog.close());
  }
  thanksDialog.showModal();
}

// License modal: the full pdf.js license text, big enough to actually read.
let licenseDialog = null;

function showLicenseDialog() {
  if (!licenseDialog) {
    licenseDialog = createModal('nbLicenseDialog');
    const box = document.createElement('div');
    box.className = 'nb-license-box';
    const title = document.createElement('h2');
    title.textContent = 'Licenses & attribution';
    const credits = document.createElement('p');
    credits.className = 'nb-license-credits';
    credits.textContent =
      'Rendering by Mozilla pdf.js (Apache License 2.0) · App shell by Tauri (MIT / Apache License 2.0)';
    const pre = document.createElement('pre');
    pre.className = 'nb-license-text';
    pre.textContent = 'Loading…';
    fetch('../LICENSE.pdfjs.txt')
      .then((r) => r.text())
      .then((t) => (pre.textContent = t))
      .catch(() => (pre.textContent = 'See LICENSE.pdfjs.txt in the application folder.'));
    const footer = document.createElement('div');
    footer.className = 'nb-modal-footer';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => licenseDialog.close());
    footer.append(close);
    box.append(title, credits, pre, footer);
    licenseDialog.append(box);
  }
  licenseDialog.showModal();
}

function buildMenuBar() {
  const defs = [
    { name: 'File', items: fileMenuItems },
    { name: 'Tools', items: toolsMenuItems },
    { name: 'About', items: aboutMenuItems },
  ];
  const bar = document.createElement('div');
  bar.id = 'nobloatMenuBar';
  bar.setAttribute('role', 'menubar');
  let open = null; // { wrapper, btn, popup }

  const close = () => {
    if (!open) return;
    open.popup.remove();
    open.wrapper.classList.remove('nb-open');
    open.btn.setAttribute('aria-expanded', 'false');
    open = null;
  };

  const openFor = (def, wrapper, btn) => {
    close();
    const popup = document.createElement('div');
    popup.className = 'nb-menu-popup';
    popup.setAttribute('role', 'menu');
    for (const item of def.items()) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'nb-menu-sep';
        popup.append(sep);
        continue;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nb-menu-item';
      row.setAttribute('role', 'menuitem');
      row.disabled = item.enabled === false;
      const check = document.createElement('span');
      check.className = 'nb-menu-check';
      check.textContent = item.checked ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'nb-menu-label';
      label.textContent = item.label;
      row.append(check, label);
      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'nb-menu-shortcut';
        shortcut.textContent = item.shortcut;
        row.append(shortcut);
      }
      row.addEventListener('click', () => {
        close();
        item.action?.();
      });
      popup.append(row);
    }
    wrapper.append(popup);
    wrapper.classList.add('nb-open');
    btn.setAttribute('aria-expanded', 'true');
    open = { wrapper, btn, popup };
  };

  for (const def of defs) {
    const wrapper = document.createElement('div');
    wrapper.className = 'nb-menu';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nb-menu-btn';
    btn.textContent = def.name;
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      if (open?.wrapper === wrapper) close();
      else openFor(def, wrapper, btn);
    });
    // Classic menubar behavior: once a menu is open, hovering a sibling
    // switches to it.
    btn.addEventListener('pointerenter', () => {
      if (open && open.wrapper !== wrapper) openFor(def, wrapper, btn);
    });
    wrapper.append(btn);
    bar.append(wrapper);
  }

  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (open && !bar.contains(ev.target)) close();
    },
    { capture: true }
  );
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Escape' && open) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        close();
      }
    },
    { capture: true }
  );

  return bar;
}

// ---------------------------------------------------------------------------
// Tab bar UI

function renderTabBar() {
  const bar = document.getElementById('nobloatTabBar');
  if (!bar) return;
  bar.textContent = '';

  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className =
      'nb-tab' + (tab.id === activeTabId ? ' nb-active' : '') + (tab.bookmarksDirty ? ' nb-dirty' : '');
    el.title = tab.bookmarksDirty ? `${tab.path} (unsaved bookmark changes)` : tab.path;
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
  add.title = `Open PDF (${shortcutLabel('Ctrl+O')})`;
  add.setAttribute('aria-label', 'Open PDF');
  add.addEventListener('click', pickAndOpen);
  bar.append(add);
}

// ---------------------------------------------------------------------------
// Wiring

window.addEventListener('DOMContentLoaded', () => {
  // One header strip at the very top: menus on the left, tabs filling the
  // rest of the row (body is turned into a flex column in nobloat.css;
  // #outerContainer flexes to fill the rest).
  const menuBar = buildMenuBar();
  document.body.insertBefore(menuBar, document.body.firstChild);
  window.__TAURI__.app
    ?.getVersion()
    .then((v) => {
      appVersion = v;
    })
    .catch(() => {});

  const tabBar = document.createElement('div');
  tabBar.id = 'nobloatTabBar';
  menuBar.append(tabBar);

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
    hint.textContent = `Drop a PDF here, or press ${shortcutLabel('Ctrl+O')} to open`;
    empty.append(img, title, hint);
    mainContainer.append(empty);
  }

  // "Bookmarks" toolbar button, leftmost of the right-side toolbar cluster
  // (before the annotation tools): shows the bookmarks panel (adding happens
  // in the panel, or via Ctrl+B).
  const editorButtons = document.getElementById('editorModeButtons');
  if (editorButtons) {
    const bmBtn = document.createElement('button');
    bmBtn.id = 'nobloatAddBookmark';
    bmBtn.className = 'toolbarButton';
    bmBtn.type = 'button';
    bmBtn.title = 'Bookmarks';
    bmBtn.setAttribute('aria-label', 'Bookmarks');
    bmBtn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path fill="currentColor" d="M4.5 1A1.5 1.5 0 0 0 3 2.5v12.1a.4.4 0 0 0 .63.33L8 12l4.37 2.93a.4.4 0 0 0 .63-.33V2.5A1.5 1.5 0 0 0 11.5 1h-7zm.5 1.5h6v10.2L8 10.2l-3 2.5V2.5z"/>' +
      '</svg>';
    bmBtn.addEventListener('click', () => {
      window.PDFViewerApplication?.viewsManager?.switchView(SIDEBAR_VIEW_OUTLINE, true);
    });
    editorButtons.before(bmBtn);
  }

  // Merge this tab's bookmarks into the outline view whenever pdf.js
  // (re)renders it, and drop the unsaved marker once a save goes through.
  (async () => {
    const app = window.PDFViewerApplication;
    await app.initializedPromise;
    app.eventBus.on('documentloaded', () => {
      const tab = activeTab();
      const doc = app.pdfDocument;
      if (!tab || !doc) return;
      // Same tab, different bytes: the file changed on disk, usually because
      // the user saved their bookmark edits into it. Those edits are now
      // either baked into the file or stale against its new outline, so
      // start clean instead of showing (and re-saving) duplicates.
      const fingerprint = doc.fingerprints.join('|');
      if (tab.lastFingerprint && tab.lastFingerprint !== fingerprint) {
        tab.bookmarks = [];
        tab.deletedOutline = [];
        tab.bookmarksDirty = false;
        updateChrome();
      }
      tab.lastFingerprint = fingerprint;
    });
    app.eventBus.on('outlineloaded', () => {
      if (suppressOutlineLoaded) return;
      // Always take over the bookmarks panel: existing rows need delete
      // buttons, session edits need merging, and even an empty panel needs
      // its "+ Add bookmark" row.
      if (activeTab()) renderMergedOutline();
    });
    app.eventBus.on('nobloatdocumentsaved', () => {
      const tab = activeTab();
      if (tab) {
        tab.bookmarksDirty = false;
        updateChrome();
        renderMergedOutline(); // retire the in-panel save button
      }
    });
  })();

  renderTabBar();

  // Closing the window with unsaved bookmark changes in ANY tab gets the
  // same warning as closing a single tab. preventDefault() must run before
  // any await; destroy() skips this handler on the way out.
  tauriWindow.getCurrentWindow().onCloseRequested(async (event) => {
    const dirty = tabs.filter((t) => t.bookmarksDirty);
    if (dirty.length === 0) return;
    event.preventDefault();
    let ok = true;
    try {
      ok = await window.__TAURI__.dialog.confirm(
        dirty.length === 1
          ? `"${dirty[0].name}" has bookmark changes that were not saved into the PDF. Close anyway?`
          : `${dirty.length} open PDFs have bookmark changes that were not saved. Close anyway?`,
        { title: 'No Bloat PDF', kind: 'warning' }
      );
    } catch {
      /* dialog unavailable: close without blocking */
    }
    if (ok) tauriWindow.getCurrentWindow().destroy();
  });

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
      } else if (plainCtrl && ev.key.toLowerCase() === 'b') {
        if (ev.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        action = addBookmark;
      } else if (plainCtrl && ev.key.toLowerCase() === 'w') {
        action = () => activeTabId !== null && closeTab(activeTabId);
      } else if (plainCtrl && ev.key.toLowerCase() === 's') {
        action = saveActiveTab; // in-place save (File > Save), replaces pdf.js's dialog flow
      } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 's') {
        action = saveActiveTabAs;
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
