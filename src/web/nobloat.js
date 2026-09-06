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

// Opens a URL in the system browser. The opener plugin rejects if the URL is
// outside the capability's scope (see src-tauri/capabilities/default.json), so
// never swallow the failure: a silently dead link reads to the user as a
// broken button with nothing to go on.
async function openExternal(url) {
  try {
    await window.__TAURI__.opener.openUrl(url);
  } catch (err) {
    console.error('No Bloat PDF: could not open', url, err);
    window.__TAURI__.dialog
      .message(`Couldn't open your browser for:\n${url}`, { title: 'No Bloat PDF', kind: 'error' })
      .catch(() => {});
  }
}

// PDFs can carry links to websites. pdf.js renders those as plain <a href>
// anchors with no target (externalLinkTarget = NONE), so an uncaught click
// navigates the webview itself: the viewer, every open tab, and all of this
// file's JS are replaced by the website, and with the app's scripts gone the
// window can no longer close itself or receive forwarded file opens. Catch
// every anchor click at the document level and route anything that leaves the
// app's own origin to the system browser. In-viewer anchors (page/outline
// destinations, "#" hrefs with their own handlers) resolve to this page's
// origin and pass through untouched.
function interceptExternalAnchor(ev) {
  const link = ev.target.closest?.('a[href]');
  if (!link) return;
  let url;
  try {
    url = new URL(link.href, location.href);
  } catch {
    return;
  }
  if (url.origin === location.origin) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  openExternal(url.href);
}
document.addEventListener('click', interceptExternalAnchor, { capture: true });
// Middle-click asks the webview for a new window with the same result.
document.addEventListener(
  'auxclick',
  (ev) => {
    if (ev.button === 1) interceptExternalAnchor(ev);
  },
  { capture: true }
);

document.addEventListener('webviewerloaded', () => {
  const opts = window.PDFViewerApplicationOptions;
  opts.set('defaultUrl', ''); // never load the bundled Mozilla demo document
  opts.set('enableScripting', false); // PDF-embedded JS sandbox: off (speed, size, scope)
  opts.set('printResolution', 300);
  // Page editing in the Pages panel: per-thumbnail checkboxes, the Manage
  // menu (Copy/Cut/Delete/Export), Delete+Backspace, drag to reorder, and the
  // undo bar. All of it already ships in this pdf.js build behind this one
  // preference; the markup, CSS, and strings are present in viewer.html /
  // viewer.css / viewer.ftl. `enableMerge` stays off: its add-file button
  // opens an <input type=file> picker, which our native-path model can't use.
  opts.set('enableSplitMerge', true);
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

// Leaving a document (switching tabs, or reloading it from disk) throws away
// the viewer's in-memory edits for it: annotations, signatures, and page
// changes live in the single pdf.js instance, not on the tab the way
// bookmarks do. Ask before dropping them. `internal` marks our own post-save
// reloads, where the edits have just been written and there is nothing to
// lose.
async function confirmLeavingDocument(id, reload) {
  const current = activeTab();
  if (!current || !hasDocumentEdits()) return true;
  const leaving = current.id !== id;
  if (!leaving && !reload) return true;
  return confirmDiscard(
    `"${current.name}" has edits that were not saved into the PDF, and they are lost when you ${
      leaving ? 'switch to another tab' : 'reload it'
    }. Continue?`
  );
}

async function activateTab(id, { reload = false, internal = false } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const alreadyActive = activeTabId === id;
  if (alreadyActive && !reload) return;
  if (!internal && !(await confirmLeavingDocument(id, reload))) return;
  // Re-check after the await: the tab list may have moved on while the
  // dialog was open.
  if (!tabs.some((t) => t.id === id)) return;
  if (activeTabId !== id) {
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
  const outstanding = unsavedSummary(tab);
  if (outstanding) {
    const ok = await confirmDiscard(
      `"${tab.name}" has ${outstanding} that were not saved into the PDF. Close it anyway?`
    );
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

// Writes PDF bytes to `target`. When that is the active tab's own file the
// document is closed first: pdf.js may still be range-reading it, and
// Windows refuses to replace a file that is open. Resolves to whether that
// happened, so the caller can reopen the tab from the new bytes.
async function writePdfBytes(target, data) {
  const tab = activeTab();
  const sameFile = !!tab && normPath(target) === normPath(tab.path);
  if (sameFile) {
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
  return sameFile;
}

window.nobloatSaveFile = async function (data, suggestedName) {
  const tab = activeTab();
  // File > Save presets the tab's own path; everything else asks where to save.
  const preset = directSaveTarget;
  directSaveTarget = null;
  const dialogDefault = saveDialogDefault;
  saveDialogDefault = null;
  const target =
    preset ??
    (await window.__TAURI__.dialog.save({
      defaultPath: dialogDefault ?? tab?.path ?? suggestedName ?? 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }));
  if (!target) return false; // user cancelled the dialog
  const sameFile = !!tab && normPath(target) === normPath(tab.path);
  try {
    // Overwriting the tab's own file: the tab reloads from the new bytes
    // below (the fingerprint change then retires the session's bookmark
    // edits, which are now part of the file itself).
    await writePdfBytes(target, data);
  } catch (err) {
    console.error('No Bloat PDF: save failed', err);
    window.__TAURI__.dialog
      .message(`Couldn't save the PDF.\n\n${err?.message ?? err}`, {
        title: 'No Bloat PDF',
        kind: 'error',
      })
      .catch(() => {});
    // Reopen what we closed. Internal: nothing was written, so the edits are
    // still the ones already in the viewer.
    if (sameFile) activateTab(tab.id, { reload: true, internal: true });
    return false;
  }
  showToast(`Saved ${baseName(target)}`);
  if (sameFile) {
    // Internal: these edits were just written to this very file, so there is
    // nothing to warn about discarding.
    activateTab(tab.id, { reload: true, internal: true });
  }
  return true;
};

// ---------------------------------------------------------------------------
// Combine Files
//
// File > Combine Files… (and the button on the empty state) opens a screen
// over the viewer: drop PDFs and images on it or pick them with the native
// dialog, drag the cards into order, and Combine writes one new PDF and
// opens it in a tab. Building the PDF is pdf.js's job: the page extractor
// that saves page edits also takes whole documents as bytes and images as
// bitmaps, and copies their pages into a fresh file. It has to run against
// an open document, so a one-page blank PDF made here plays host; none of
// its pages are asked for, so nothing of it reaches the output.
//
// TIFF is the one format the webview cannot decode on its own, so tiff.js
// (UTIF) is loaded the first time a TIFF is added and never otherwise.

const COMBINE_KINDS = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  tif: 'tiff',
  tiff: 'tiff',
};
const COMBINE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};
const COMBINE_FORMAT = {
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  gif: 'GIF',
  bmp: 'BMP',
  webp: 'WebP',
  tif: 'TIFF',
  tiff: 'TIFF',
};
// Longest side of an image page in pixels: the same ceiling pdf.js's own
// Pages-panel merge applies. A 300 dpi letter scan (3300 px) fits under it.
const COMBINE_MAX_SIDE = 4096;
// Decoded bitmaps go to the worker a batch at a time so a long scan is never
// held in memory all at once; each pass appends to the previous pass's
// output. The budget is decoded RGBA bytes per pass.
const COMBINE_PASS_BUDGET = 192 * 1024 * 1024;
const COMBINE_THUMB = 128; // CSS px, longest side of a card thumbnail

// items: { id, path, name, kind, ext, status: loading|ready|error, bytes,
// pages, width, height, thumb (canvas), password, ifds, error, el }
const combine = { items: [], busy: false, seq: 0, worker: null, el: null, addTile: null };

// Programmatic entry point, in the spirit of window.nobloatBookmarks: opens
// the screen and adds files by path. Nothing in the app calls it today.
window.nobloatCombine = {
  open: () => openCombine(),
  addPaths: (paths) => {
    openCombine();
    addCombinePaths(paths);
  },
};

function combineKind(path) {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return { kind: COMBINE_KINDS[ext] ?? null, ext };
}

function combineIsOpen() {
  return !!combine.el && !combine.el.hidden;
}

async function readFileBytes(path) {
  const res = await fetch(core.convertFileSrc(path));
  if (!res.ok) throw new Error(`the file could not be read (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// One worker for as long as the screen is open: pdf.js would otherwise start
// a fresh worker, and load its script, for every file inspected.
function combineWorker() {
  const lib = globalThis.pdfjsLib;
  // The viewer sets this lazily; the screen can be used before any document
  // has been opened.
  lib.GlobalWorkerOptions.workerSrc ||=
    window.PDFViewerApplicationOptions?.get('workerSrc') || '../build/pdf.worker.mjs';
  return (combine.worker ??= new lib.PDFWorker({ name: 'nobloat-combine' }));
}

let tiffLibPromise = null;
function loadTiffLib() {
  return (tiffLibPromise ??= new Promise((resolve, reject) => {
    const fail = () => {
      tiffLibPromise = null;
      reject(new Error('the TIFF decoder could not be loaded'));
    };
    const script = document.createElement('script');
    script.src = 'tiff.js';
    script.onload = () => (window.UTIF ? resolve(window.UTIF) : fail());
    script.onerror = fail;
    document.head.append(script);
  }));
}

// Page IFDs only: thumbnails and sub-IFDs carry no dimensions of their own.
function tiffPages(UTIF, bytes) {
  return UTIF.decode(bytes.buffer).filter((ifd) => ifd.t256?.[0] > 0 && ifd.t257?.[0] > 0);
}

// Decodes one page of an item at full size. The caller owns the bitmap.
async function decodeImagePage(item, pageIndex) {
  if (item.kind === 'tiff') {
    const UTIF = await loadTiffLib();
    item.ifds ??= tiffPages(UTIF, item.bytes);
    const ifd = item.ifds[pageIndex];
    UTIF.decodeImage(item.bytes.buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    delete ifd.data; // the decoded strips; the RGBA copy is all that is needed
    const image = new ImageData(
      new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length),
      ifd.width,
      ifd.height
    );
    return createImageBitmap(image);
  }
  return createImageBitmap(new Blob([item.bytes], { type: COMBINE_MIME[item.ext] }));
}

// Shrinks a bitmap so its longest side is at most maxSide, closing the input
// when a new one is made. Drawn through a canvas rather than
// createImageBitmap's resize options, which older WebKit lacks.
async function boundBitmap(bitmap, maxSide) {
  const s = maxSide / Math.max(bitmap.width, bitmap.height);
  if (s >= 1) return bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * s));
  canvas.height = Math.max(1, Math.round(bitmap.height * s));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return createImageBitmap(canvas);
}

// Password prompt for protected PDFs added to the screen. The password is
// kept on the item and handed to the worker again when combining.
let passwordDialog = null;
function askPassword(name, retry) {
  return new Promise((resolve) => {
    if (!passwordDialog) {
      passwordDialog = createModal('nbPasswordDialog');
      passwordDialog.innerHTML = `
        <form method="dialog" class="nb-password-box">
          <h2>Password required</h2>
          <p></p>
          <input type="password" autocomplete="off" aria-label="Password" />
          <div class="nb-modal-footer">
            <button type="button" class="nb-btn-quiet">Cancel</button>
            <button type="submit" value="ok">OK</button>
          </div>
        </form>`;
      passwordDialog.querySelector('.nb-btn-quiet').addEventListener('click', () => passwordDialog.close(''));
    }
    const input = passwordDialog.querySelector('input');
    passwordDialog.querySelector('p').textContent = retry
      ? `That password did not open "${name}". Try again?`
      : `"${name}" is password protected. Enter its password to combine it.`;
    input.value = '';
    passwordDialog.returnValue = '';
    passwordDialog.addEventListener(
      'close',
      () => resolve(passwordDialog.returnValue === 'ok' ? input.value : null),
      { once: true }
    );
    passwordDialog.showModal();
    input.focus();
  });
}

async function openPdfForInspection(item) {
  for (;;) {
    // pdf.js transfers `data` to the worker, so it gets its own copy.
    const task = globalThis.pdfjsLib.getDocument({
      data: item.bytes.slice(),
      worker: combineWorker(),
      password: item.password,
    });
    try {
      await task.promise;
      return task; // the task owns the document; destroy() lives on it
    } catch (err) {
      await task.destroy().catch(() => {});
      if (err?.name !== 'PasswordException') throw err;
      const password = await askPassword(item.name, item.password !== undefined);
      if (password === null) throw new Error('it is password protected');
      item.password = password;
    }
  }
}

async function inspectItem(item) {
  item.bytes = await readFileBytes(item.path);
  const dpr = window.devicePixelRatio || 1;
  if (item.kind === 'pdf') {
    const task = await openPdfForInspection(item);
    const doc = await task.promise;
    try {
      item.pages = doc.numPages;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: (COMBINE_THUMB * dpr) / Math.max(base.width, base.height),
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      item.thumb = canvas;
    } finally {
      await task.destroy().catch(() => {});
    }
    return;
  }
  if (item.kind === 'tiff') {
    item.ifds = tiffPages(await loadTiffLib(), item.bytes);
    if (!item.ifds.length) throw new Error('no image pages were found in it');
    item.pages = item.ifds.length;
  } else {
    item.pages = 1;
  }
  const full = await decodeImagePage(item, 0);
  item.width = full.width;
  item.height = full.height;
  const small = await boundBitmap(full, COMBINE_THUMB * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = small.width;
  canvas.height = small.height;
  canvas.getContext('2d').drawImage(small, 0, 0);
  small.close();
  item.thumb = canvas;
}

function combineErrorText(err) {
  const text = String(err?.message ?? err ?? '').trim();
  if (!text) return 'it could not be read';
  if (/^InvalidPDFException|Invalid PDF structure/i.test(text)) return 'it is not a valid PDF';
  if (err?.name === 'InvalidStateError' || /decod/i.test(text)) return 'the image could not be decoded';
  return text.replace(/\.$/, '');
}

function addCombinePaths(paths) {
  const accepted = [];
  let skipped = 0;
  for (const path of paths ?? []) {
    if (typeof path !== 'string') continue;
    const { kind, ext } = combineKind(path);
    if (!kind) {
      skipped++;
      continue;
    }
    accepted.push({
      id: ++combine.seq,
      path,
      name: baseName(path),
      kind,
      ext,
      status: 'loading',
      pages: 0,
    });
  }
  if (skipped) {
    showToast(
      skipped === 1
        ? 'Skipped 1 file that is not a PDF or image'
        : `Skipped ${skipped} files that are not PDFs or images`
    );
  }
  if (!accepted.length) return;
  for (const item of accepted) {
    item.el = buildCombineCard(item);
    combine.items.push(item);
  }
  renderCombineList();
  // One file at a time: they are already in order, and a dozen decodes in
  // parallel would only fight over memory.
  (async () => {
    for (const item of accepted) {
      if (!combine.items.includes(item)) continue; // removed while waiting
      try {
        await inspectItem(item);
        item.status = 'ready';
      } catch (err) {
        console.error('No Bloat PDF: could not add', item.path, err);
        item.status = 'error';
        item.error = combineErrorText(err);
        item.bytes = null;
      }
      updateCombineCard(item);
      updateCombineStatus();
    }
  })();
}

function removeCombineItem(item) {
  const idx = combine.items.indexOf(item);
  if (idx === -1 || combine.busy) return;
  combine.items.splice(idx, 1);
  item.bytes = null;
  renderCombineList();
  // Keep the keyboard on the list: the neighbour that slid into the slot.
  const next = combine.items[Math.min(idx, combine.items.length - 1)];
  (next?.el ?? combine.el.querySelector('.nb-combine-add, .nb-combine-empty button'))?.focus();
}

// `pinned` is a card that must stay in the DOM while the list is reordered
// (the one under pointer capture during a drag).
function moveCombineItem(item, to, pinned = null) {
  const from = combine.items.indexOf(item);
  if (from === -1 || to < 0 || to >= combine.items.length || to === from) return;
  combine.items.splice(from, 1);
  combine.items.splice(to, 0, item);
  renderCombineList(pinned);
}

async function pickCombineFiles() {
  const images = Object.keys(COMBINE_KINDS).filter((e) => e !== 'pdf');
  const picked = await window.__TAURI__.dialog.open({
    multiple: true,
    directory: false,
    filters: [
      { name: 'PDFs and images', extensions: Object.keys(COMBINE_KINDS) },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Images', extensions: images },
    ],
  });
  if (!picked) return;
  addCombinePaths(Array.isArray(picked) ? picked : [picked]);
}

// --- Screen -----------------------------------------------------------------

function ensureCombineScreen() {
  if (combine.el) return combine.el;
  const el = document.createElement('div');
  el.id = 'nobloatCombine';
  el.hidden = true;
  el.innerHTML = `
    <div class="nb-combine-head">
      <h2>Combine Files</h2>
      <p>Drop PDFs and images here, put them in order, and combine them into one new PDF. Nothing leaves your computer.</p>
    </div>
    <div class="nb-combine-list" role="list" aria-label="Files to combine"></div>
    <div class="nb-combine-foot">
      <span class="nb-spinner" hidden></span>
      <span class="nb-combine-status" aria-live="polite"></span>
      <button type="button" class="nb-btn" data-act="cancel">Cancel</button>
      <button type="button" class="nb-btn" data-act="add">Add files…</button>
      <button type="button" class="nb-btn nb-btn-primary" data-act="combine">Combine</button>
    </div>
    <div class="nb-combine-veil"><span>Drop to add</span></div>`;
  el.querySelector('[data-act="cancel"]').addEventListener('click', closeCombine);
  el.querySelector('[data-act="add"]').addEventListener('click', pickCombineFiles);
  el.querySelector('[data-act="combine"]').addEventListener('click', () => runCombine());
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && combine.items.length === 0 && !combine.busy) {
      ev.preventDefault();
      closeCombine();
    }
  });
  document.getElementById('mainContainer')?.append(el);
  combine.el = el;
  renderCombineList();
  return el;
}

function openCombine() {
  const el = ensureCombineScreen();
  el.hidden = false;
  updateCombineStatus();
  el.querySelector('.nb-combine-empty button, [data-act="add"]')?.focus();
}

function closeCombine() {
  if (!combine.el || combine.busy) return;
  combine.el.hidden = true;
  combine.el.classList.remove('nb-dragover');
  for (const item of combine.items) item.bytes = null;
  combine.items = [];
  renderCombineList();
  combine.worker?.destroy();
  combine.worker = null;
}

// Native drag feedback: Tauri reports enter/over/leave/drop for OS drags.
function combineDragFeedback(type) {
  combine.el?.classList.toggle('nb-dragover', type === 'enter' || type === 'over');
}

function buildCombineCard(item) {
  const card = document.createElement('div');
  card.className = 'nb-combine-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'listitem');
  card.title = item.path;
  card.innerHTML = `
    <span class="nb-combine-index"></span>
    <button type="button" class="nb-combine-remove" aria-label="Remove">×</button>
    <div class="nb-combine-thumb"><span class="nb-spinner"></span></div>
    <div class="nb-combine-name"></div>
    <div class="nb-combine-meta">Loading…</div>`;
  card.querySelector('.nb-combine-name').textContent = item.name;
  card.querySelector('.nb-combine-remove').addEventListener('click', (ev) => {
    ev.stopPropagation();
    removeCombineItem(item);
  });
  card.addEventListener('keydown', (ev) => {
    if (ev.target !== card) return;
    const idx = combine.items.indexOf(item);
    let handled = true;
    if (ev.key === 'Delete' || ev.key === 'Backspace') removeCombineItem(item);
    else if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp')) {
      moveCombineItem(item, idx - 1);
      card.focus();
    } else if (ev.altKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowDown')) {
      moveCombineItem(item, idx + 1);
      card.focus();
    } else if (ev.key === 'ArrowLeft') combine.items[idx - 1]?.el.focus();
    else if (ev.key === 'ArrowRight') combine.items[idx + 1]?.el.focus();
    else handled = false;
    if (handled) ev.preventDefault();
  });
  attachCardDrag(card, item);
  return card;
}

function combineMetaText(item) {
  const pages = item.pages === 1 ? '1 page' : `${item.pages} pages`;
  if (item.kind === 'pdf') return pages;
  const format = COMBINE_FORMAT[item.ext];
  return item.kind === 'tiff' ? `${format} · ${pages}` : `${format} · ${item.width} × ${item.height}`;
}

function updateCombineCard(item) {
  const card = item.el;
  const thumb = card.querySelector('.nb-combine-thumb');
  const meta = card.querySelector('.nb-combine-meta');
  card.classList.toggle('nb-error', item.status === 'error');
  if (item.status === 'ready') {
    thumb.replaceChildren(item.thumb);
    meta.textContent = combineMetaText(item);
    card.title = item.path;
  } else if (item.status === 'error') {
    const mark = document.createElement('span');
    mark.className = 'nb-combine-errmark';
    mark.textContent = '!';
    thumb.replaceChildren(mark);
    meta.textContent = `Can't be combined: ${item.error}`;
    card.title = `${item.path}\nCan't be combined: ${item.error}`;
  }
}

// Rebuilds the list from combine.items. A `pinned` card is never detached:
// removing an element from the document releases its pointer capture, which
// would end a drag on the first swap, so everything else moves around it.
function renderCombineList(pinned = null) {
  const list = combine.el?.querySelector('.nb-combine-list');
  if (!list) return;
  if (combine.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nb-combine-empty';
    empty.innerHTML = `
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" d="M14 4a4 4 0 0 0-4 4v32a4 4 0 0 0 4 4h20a4 4 0 0 0 4-4V16L26 4H14zm11 3.5L34.5 17H27a2 2 0 0 1-2-2V7.5zM13 8a1 1 0 0 1 1-1h8v8a5 5 0 0 0 5 5h8v20a1 1 0 0 1-1 1H14a1 1 0 0 1-1-1V8zm11 15a1.5 1.5 0 0 1 1.5 1.5V31l2.44-2.44a1.5 1.5 0 1 1 2.12 2.12l-5 5a1.5 1.5 0 0 1-2.12 0l-5-5a1.5 1.5 0 1 1 2.12-2.12L22.5 31v-6.5A1.5 1.5 0 0 1 24 23z"/></svg>
      <div class="nb-combine-empty-title">Drop PDFs and images here</div>
      <div class="nb-combine-empty-hint">PDF, PNG, JPEG, TIFF, GIF, BMP, WebP. Pages come out in the order you arrange the files.</div>
      <button type="button" class="nb-btn nb-btn-primary">Choose files…</button>`;
    empty.querySelector('button').addEventListener('click', pickCombineFiles);
    list.replaceChildren(empty);
  } else {
    if (!combine.addTile) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'nb-combine-add';
      add.innerHTML = '<span class="nb-combine-add-plus">+</span><span>Add files…</span>';
      add.addEventListener('click', pickCombineFiles);
      combine.addTile = add;
    }
    const add = combine.addTile;
    const pin = pinned && pinned.parentElement === list ? combine.items.findIndex((i) => i.el === pinned) : -1;
    if (pin === -1) {
      list.replaceChildren(...combine.items.map((item) => item.el), add);
    } else {
      for (const item of combine.items.slice(0, pin)) list.insertBefore(item.el, pinned);
      if (add.parentElement !== list) list.append(add);
      for (const item of combine.items.slice(pin + 1)) list.insertBefore(item.el, add);
    }
    combine.items.forEach((item, i) => {
      item.el.querySelector('.nb-combine-index').textContent = String(i + 1);
    });
  }
  updateCombineStatus();
}

function updateCombineStatus() {
  const el = combine.el;
  if (!el) return;
  const items = combine.items;
  const ready = items.filter((i) => i.status === 'ready');
  const loading = items.filter((i) => i.status === 'loading').length;
  const errors = items.length - ready.length - loading;
  if (!combine.busy) {
    const pages = ready.reduce((n, i) => n + i.pages, 0);
    const parts = [];
    if (items.length) {
      parts.push(items.length === 1 ? '1 file' : `${items.length} files`);
      parts.push(pages === 1 ? '1 page' : `${pages} pages`);
    }
    if (errors) parts.push(errors === 1 ? "1 can't be combined" : `${errors} can't be combined`);
    if (loading) parts.push('loading…');
    el.querySelector('.nb-combine-status').textContent = parts.join(' · ');
  }
  el.querySelector('[data-act="combine"]').disabled = combine.busy || loading > 0 || ready.length === 0;
  el.querySelector('[data-act="add"]').disabled = combine.busy;
  el.querySelector('[data-act="cancel"]').disabled = combine.busy;
}

function setCombineBusy(busy, text) {
  combine.busy = busy;
  combine.el.classList.toggle('nb-busy', busy);
  combine.el.querySelector('.nb-combine-foot .nb-spinner').hidden = !busy;
  if (text !== undefined) combine.el.querySelector('.nb-combine-status').textContent = text;
  updateCombineStatus();
}

// Drag to reorder, on pointer events rather than HTML5 drag and drop, which
// Tauri's native drop handling swallows on Windows. The card follows the
// pointer; whenever the pointer is over another card the two trade places.
// Cards are all one size, so a swap never shifts the card under the pointer
// and the order cannot flap.
function attachCardDrag(card, item) {
  card.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || combine.busy || ev.target.closest('button')) return;
    const list = card.parentElement;
    const start = { x: ev.clientX, y: ev.clientY };
    const rect = card.getBoundingClientRect();
    const grab = { x: start.x - rect.left, y: start.y - rect.top };
    let dragging = false;
    const place = (x, y) => {
      const listRect = list.getBoundingClientRect();
      const baseX = listRect.left + card.offsetLeft - list.scrollLeft;
      const baseY = listRect.top + card.offsetTop - list.scrollTop;
      card.style.transform = `translate(${x - grab.x - baseX}px, ${y - grab.y - baseY}px)`;
    };
    const move = (e) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
        dragging = true;
        card.classList.add('nb-dragging');
        card.setPointerCapture(ev.pointerId);
      }
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.nb-combine-card');
      if (over && over !== card) {
        const to = combine.items.findIndex((i) => i.el === over);
        if (to !== -1) moveCombineItem(item, to, card);
      }
      place(e.clientX, e.clientY);
    };
    const end = () => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', end);
      card.removeEventListener('pointercancel', end);
      if (!dragging) return;
      card.classList.remove('nb-dragging');
      card.style.transform = '';
      card.focus();
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  });
}

// --- Building the PDF -------------------------------------------------------

// The host document for the extractor: one blank letter page, never copied.
function blankPdfBytes() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // ASCII only, so offsets are byte offsets
}

function combineDefaultPath(firstPath) {
  const cut = Math.max(firstPath.lastIndexOf('\\'), firstPath.lastIndexOf('/'));
  if (cut === -1) return 'Combined.pdf';
  return `${firstPath.slice(0, cut + 1)}Combined.pdf`;
}

// `target`: write there without asking (the command-line flow); otherwise
// the Save dialog decides.
async function runCombine({ target: preset = null } = {}) {
  const ready = combine.items.filter((i) => i.status === 'ready');
  if (combine.busy || ready.length === 0) return;
  // Units of work in output order: a PDF is one unit, an image page is one
  // unit. Weights are the bytes the worker has to take in for the unit.
  const units = [];
  for (const item of ready) {
    if (item.kind === 'pdf') {
      units.push({
        pages: item.pages,
        weight: item.bytes.length,
        make: async () => ({ document: item.bytes, password: item.password }),
      });
      continue;
    }
    const shrink = Math.min(1, COMBINE_MAX_SIDE / Math.max(item.width, item.height));
    const weight = Math.ceil(item.width * shrink) * Math.ceil(item.height * shrink) * 4;
    for (let p = 0; p < item.pages; p++) {
      units.push({
        pages: 1,
        weight,
        make: async () => ({
          image: await boundBitmap(await decodeImagePage(item, p), COMBINE_MAX_SIDE),
          nobloatFit: true,
        }),
      });
    }
  }
  const total = units.reduce((n, u) => n + u.pages, 0);
  setCombineBusy(true, 'Combining…');
  let hostTask = null;
  let output = null;
  try {
    hostTask = globalThis.pdfjsLib.getDocument({ data: blankPdfBytes(), worker: combineWorker() });
    const host = await hostTask.promise;
    let done = 0;
    for (let i = 0; i < units.length; ) {
      const entries = output ? [{ document: output }] : [];
      let weight = 0;
      do {
        const unit = units[i++];
        entries.push(await unit.make());
        weight += unit.weight;
        done += unit.pages;
      } while (i < units.length && weight + units[i].weight <= COMBINE_PASS_BUDGET);
      output = await host.extractPages(entries);
      if (!output) throw new Error('The combined PDF could not be written.');
      setCombineBusy(true, `Combining… ${done} of ${total} pages`);
    }
  } catch (err) {
    console.error('No Bloat PDF: combine failed', err);
    window.__TAURI__.dialog
      .message(`Couldn't combine the files.\n\n${err?.message ?? err}`, {
        title: 'No Bloat PDF',
        kind: 'error',
      })
      .catch(() => {});
    setCombineBusy(false);
    return;
  } finally {
    await hostTask?.destroy().catch(() => {});
  }
  setCombineBusy(true, preset ? 'Saving…' : 'Choose where to save…');
  let target = preset;
  try {
    target ??= await window.__TAURI__.dialog.save({
      defaultPath: combineDefaultPath(ready[0].path),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!target) return; // cancelled: the list stays for another try
    await writePdfBytes(target, output);
  } catch (err) {
    console.error('No Bloat PDF: could not save the combined PDF', err);
    window.__TAURI__.dialog
      .message(`Couldn't save the PDF.\n\n${err?.message ?? err}`, {
        title: 'No Bloat PDF',
        kind: 'error',
      })
      .catch(() => {});
    return;
  } finally {
    setCombineBusy(false);
  }
  showToast(`Saved ${baseName(target)}`);
  closeCombine();
  openPaths([target]);
}

// Command line: `--combine <out.pdf> <files…>` (cold start via the
// combine_request command, warm start via the combine-files event). Shows
// the screen with the files, waits for them to load, and writes the result
// to <out.pdf> without asking. The macOS CI smoke test drives this.
async function combineFromCommandLine(out, paths) {
  if (typeof out !== 'string' || !out) return;
  openCombine();
  addCombinePaths(paths);
  while (combine.items.some((i) => i.status === 'loading')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await runCombine({ target: out });
}

// ---------------------------------------------------------------------------
// Page editing (Pages panel)
//
// pdf.js owns this feature end to end: the thumbnail checkboxes, Delete and
// Backspace, drag to reorder, the undo bar, and the extractPages rebuild that
// writes the result out. Switching it on is the single `enableSplitMerge`
// preference set in the webviewerloaded hook at the top of this file.
//
// Two pieces are deliberately left to the host application:
//
//   1. The right-click menu. pdf.js ships no context-menu UI of its own: on
//      contextmenu it dispatches `editingstateschanged` describing what is
//      actionable and then performs whatever `editingaction` is dispatched
//      back at it. Firefox answers that with a native menu; we answer with
//      the same popup the menu bar draws.
//   2. Warning before a page-edit save discards pending bookmark edits: see
//      nobloatConfirmPageSave below, which viewer.mjs calls.

// Selection state is pdf.js-private, but it is a pure function of the
// thumbnail checkboxes, so read those instead of the internals. This mirrors
// the viewer's own #canDelete(), which refuses to delete every page of a
// document. The values only enable/disable menu rows; pdf.js re-checks before
// acting, so a stale read can never delete something it shouldn't.
function pagesPanelState() {
  const boxes = [
    ...(document.getElementById('thumbnailsView')?.querySelectorAll('.thumbnail input[type="checkbox"]') ??
      []),
  ];
  const selected = boxes.filter((b) => b.checked).length;
  return {
    hasSelectedPages: selected > 0,
    canDeletePages: selected > 0 && selected < boxes.length,
  };
}

// Right-clicking a page outside the current selection makes it the selection,
// the way file managers do; right-clicking inside an existing multi-selection
// leaves that selection alone so the action applies to all of it. The only
// supported way into pdf.js's selection is the checkbox click it listens for.
function selectOnlyThumbnail(pageNumber) {
  const container = document.getElementById('thumbnailsView');
  if (!container) return;
  for (const thumb of container.querySelectorAll('.thumbnail')) {
    const box = thumb.querySelector('input[type="checkbox"]');
    if (!box) continue;
    const wanted = Number(thumb.getAttribute('page-number')) === pageNumber;
    if (box.checked !== wanted) box.click();
  }
}

// Wording follows the Pages panel's own Manage menu so the two agree.
const PAGE_MENU_ITEMS = [
  { name: 'deletePage', label: 'Delete', shortcut: 'Del', needs: 'delete' },
  { name: 'cutPage', label: 'Cut', shortcut: shortcutLabel('Ctrl+X'), needs: 'delete' },
  { name: 'copyPage', label: 'Copy', shortcut: shortcutLabel('Ctrl+C'), needs: 'select' },
  null,
  { name: 'savePage', label: 'Export selected…', needs: 'select' },
];

let pageMenu = null;

function closePageMenu() {
  pageMenu?.remove();
  pageMenu = null;
}

function openPageMenu(x, y) {
  closePageMenu();
  const state = pagesPanelState();
  const popup = document.createElement('div');
  popup.className = 'nb-menu-popup nb-context-popup';
  popup.setAttribute('role', 'menu');

  for (const entry of PAGE_MENU_ITEMS) {
    if (!entry) {
      const sep = document.createElement('div');
      sep.className = 'nb-menu-sep';
      popup.append(sep);
      continue;
    }
    const row = document.createElement('button');
    row.className = 'nb-menu-item';
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.disabled = entry.needs === 'delete' ? !state.canDeletePages : !state.hasSelectedPages;

    const label = document.createElement('span');
    label.className = 'nb-menu-label';
    label.textContent = entry.label;
    row.append(label);

    if (entry.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'nb-menu-shortcut';
      shortcut.textContent = entry.shortcut;
      row.append(shortcut);
    }

    row.addEventListener('click', () => {
      closePageMenu();
      window.PDFViewerApplication?.eventBus?.dispatch('editingaction', {
        source: 'nobloatPageMenu',
        name: entry.name,
      });
    });
    popup.append(row);
  }

  // Append first, then place: the popup has to be measured to be kept inside
  // the window when the click lands near an edge.
  document.body.append(popup);
  popup.style.left = `${Math.max(2, Math.min(x, window.innerWidth - popup.offsetWidth - 2))}px`;
  popup.style.top = `${Math.max(2, Math.min(y, window.innerHeight - popup.offsetHeight - 2))}px`;
  pageMenu = popup;
}

function initPageContextMenu() {
  document.addEventListener('contextmenu', (ev) => {
    const thumb = ev.target.closest?.('#thumbnailsView .thumbnail');
    if (!thumb) {
      closePageMenu();
      return;
    }
    ev.preventDefault();
    if (!thumb.querySelector('input[type="checkbox"]')?.checked) {
      selectOnlyThumbnail(Number(thumb.getAttribute('page-number')));
    }
    openPageMenu(ev.clientX, ev.clientY);
  });

  // Dismissal: anywhere else, Esc, or anything that moves the popup off the
  // thumbnail it was opened against.
  document.addEventListener('pointerdown', (ev) => {
    if (pageMenu && !pageMenu.contains(ev.target)) closePageMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closePageMenu();
  });
  window.addEventListener('resize', closePageMenu);
  window.addEventListener('blur', closePageMenu);
  document.getElementById('viewsManagerContent')?.addEventListener('scroll', closePageMenu, true);
}

// Called by viewer.mjs on its way into a save that was built by extracting
// pages. Export selected pages produces a NEW document, so it must not offer
// to overwrite the file it was carved out of; saving page edits is an
// in-place change to the open file and keeps the normal target.
window.nobloatOnExtractSave = function (isExport) {
  if (!isExport) return;
  const tab = activeTab();
  directSaveTarget = null;
  saveDialogDefault = tab?.path ? `${tab.path.replace(/\.pdf$/i, '')}-pages.pdf` : 'pages.pdf';
};

// Called by viewer.mjs before it rebuilds the file for a page-edit save. That
// path goes through extractPages, which takes no outline argument, so pending
// bookmark edits cannot come along; say so rather than dropping them quietly.
window.nobloatConfirmPageSave = async function () {
  const tab = activeTab();
  if (!tab?.bookmarksDirty) return true;
  try {
    return await window.__TAURI__.dialog.confirm(
      'Saving page changes rebuilds the PDF, and your unsaved bookmark edits cannot be carried across. Save the page changes and discard those bookmark edits?',
      {
        title: 'No Bloat PDF',
        kind: 'warning',
        okLabel: 'Save pages',
        cancelLabel: 'Cancel',
      }
    );
  } catch {
    return true; // dialog unavailable: don't block the save
  }
};

// ---------------------------------------------------------------------------
// Unsaved work
//
// Two kinds, tracked in two places. Bookmark edits live per tab in JS
// (tab.bookmarksDirty), so they survive tab switches. Document edits
// (annotations, signatures, page deletions) live inside the single pdf.js
// viewer instance, so they only exist for whichever tab is active.

function hasDocumentEdits() {
  const app = window.PDFViewerApplication;
  if (!app?.pdfDocument) return false;
  // _annotationStorageModified is pdf.js's own "edited since the last write"
  // flag: saveDocument and extractPages both clear it, so saved work stops
  // counting without us tracking saves here. (The viewer's _hasChanges() is
  // the wrong test for us: it asks whether the storage is non-empty, which
  // stays true after a save and would warn about work already on disk.)
  // Structural page edits are tracked separately and clear on reload.
  return !!app._annotationStorageModified || !!app.pdfThumbnailViewer?.hasStructuralChanges();
}

// "edits and bookmark changes" / "edits" / "bookmark changes", or null when
// the tab has nothing outstanding.
function unsavedSummary(tab) {
  const parts = [];
  if (tab.id === activeTabId && hasDocumentEdits()) parts.push('edits');
  if (tab.bookmarksDirty) parts.push('bookmark changes');
  return parts.length ? parts.join(' and ') : null;
}

async function confirmDiscard(message) {
  try {
    return await window.__TAURI__.dialog.confirm(message, {
      title: 'No Bloat PDF',
      kind: 'warning',
      okLabel: 'Discard',
      cancelLabel: 'Cancel',
    });
  } catch {
    return true; // dialog unavailable: close without blocking
  }
}

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

// When set, the Save dialog defaults here instead of the tab's own file (used
// by Sanitize Document so a slip of the finger doesn't overwrite the
// original). Consumed (and cleared) by the first save that follows.
let saveDialogDefault = null;

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

// File > Sanitize Document: rebuild the PDF from scratch through the worker's
// page extractor (with its nobloat sanitize flag) instead of the incremental
// save path. Only objects the pages actually reference are copied, so document
// metadata (Author, Title, Creator, dates), XMP metadata, document JavaScript,
// deleted content, and prior saved revisions do not survive into the new file.
// Unsaved annotation edits are baked in; the file's own outline is kept, but
// this session's pending bookmark edits are not (they ride the normal save).
async function sanitizeActiveTab() {
  const tab = activeTab();
  const doc = window.PDFViewerApplication?.pdfDocument;
  if (!tab || !doc) return;
  try {
    const data = await doc.extractPages([{ document: null }], { sanitize: true });
    if (!data) throw new Error('The document could not be rewritten.');
    directSaveTarget = null;
    saveDialogDefault = tab.path
      ? tab.path.replace(/\.pdf$/i, '') + '-sanitized.pdf'
      : 'sanitized.pdf';
    await window.nobloatSaveFile(data, 'sanitized.pdf');
  } catch (err) {
    console.error('No Bloat PDF: sanitize failed', err);
    window.__TAURI__.dialog
      .message(`Couldn't sanitize the PDF.\n\n${err?.message ?? err}`, {
        title: 'No Bloat PDF',
        kind: 'error',
      })
      .catch(() => {});
  }
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
    { label: 'Combine Files…', action: openCombine },
    { type: 'separator' },
    { label: 'Save', shortcut: shortcutLabel('Ctrl+S'), enabled: hasDoc, action: saveActiveTab },
    {
      label: 'Save As…',
      shortcut: shortcutLabel('Ctrl+Shift+S'),
      enabled: hasDoc,
      action: saveActiveTabAs,
    },
    { label: 'Sanitize Document…', enabled: hasDoc, action: sanitizeActiveTab },
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
  return [
    { label: 'About No Bloat PDF', action: showAboutDialog },
    { label: 'Special Thanks', action: showThanksDialog },
    { label: appVersion ? `Version ${appVersion}` : 'Version', enabled: false },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      action: () => openExternal('https://www.nobloatpdf.com/download.html'),
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
        openExternal(url);
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
      'Rendering by Mozilla pdf.js (Apache License 2.0) · App shell by Tauri (MIT / Apache License 2.0) · TIFF decoding by UTIF.js and tiny-inflate (MIT, see LICENSE.tiff.txt)';
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
    // The empty state lets pointer events through so drops reach the viewer;
    // the buttons opt back in.
    const actions = document.createElement('div');
    actions.className = 'nb-empty-actions';
    for (const [text, action] of [
      ['Open PDF…', pickAndOpen],
      ['Combine Files…', openCombine],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nb-btn';
      btn.textContent = text;
      btn.addEventListener('click', action);
      actions.append(btn);
    }
    empty.append(img, title, hint, actions);
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
    const dirty = tabs.map((t) => [t, unsavedSummary(t)]).filter(([, summary]) => summary);
    if (dirty.length === 0) return;
    event.preventDefault();
    const ok = await confirmDiscard(
      dirty.length === 1
        ? `"${dirty[0][0].name}" has ${dirty[0][1]} that were not saved into the PDF. Close anyway?`
        : `${dirty.length} open PDFs have changes that were not saved. Close anyway?`
    );
    if (ok) tauriWindow.getCurrentWindow().destroy();
  });

  initPageContextMenu();

  // Warm start: Rust forwards paths from a second app instance.
  tauriEvent.listen('open-file', (e) => openPaths(e.payload));
  tauriEvent.listen('combine-files', (e) => combineFromCommandLine(e.payload?.out, e.payload?.paths));

  // Native drag-and-drop delivers OS paths; the viewer's HTML5 drop handler
  // never fires on Windows while Tauri's dragDropEnabled (default) is on.
  webview.getCurrentWebview().onDragDropEvent((e) => {
    const { type } = e.payload;
    if (combineIsOpen()) {
      combineDragFeedback(type);
      if (type === 'drop' && !combine.busy) addCombinePaths(e.payload.paths);
      return;
    }
    if (type === 'drop') openPaths(e.payload.paths);
  });

  // Cold start: drain paths buffered from argv (Windows) / RunEvent::Opened
  // (macOS). A `--combine <out.pdf>` flag sends them to Combine Files instead.
  Promise.all([core.invoke('combine_request'), core.invoke('pending_files')])
    .then(([out, paths]) => (out ? combineFromCommandLine(out, paths) : openPaths(paths)))
    .catch(() => {});

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
