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
  const target = await window.__TAURI__.dialog.save({
    defaultPath: tab?.path ?? suggestedName ?? 'document.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
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

  // "Bookmarks" toolbar button, to the left of the download/save button:
  // shows the bookmarks panel (adding happens in the panel, or via Ctrl+B).
  const downloadBtn = document.getElementById('downloadButton');
  if (downloadBtn) {
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
    downloadBtn.before(bmBtn);
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
