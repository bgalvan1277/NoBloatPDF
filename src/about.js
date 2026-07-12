// About window: live version, vendored license text, and the website link —
// which must open in the system browser, never navigate this window.
const tauri = window.__TAURI__;

tauri?.app
  .getVersion()
  .then((v) => (document.getElementById('version').textContent = v))
  .catch(() => {});

fetch('LICENSE.pdfjs.txt')
  .then((r) => r.text())
  .then((t) => (document.getElementById('licenseText').textContent = t))
  .catch(() => (document.getElementById('licenseText').textContent = 'See LICENSE.pdfjs.txt in the application folder.'));

for (const [id, url] of [
  ['siteLink', 'https://www.nobloatpdf.com'],
  ['coffeeLink', 'https://buymeacoffee.com/briangalvan'],
]) {
  document.getElementById(id).addEventListener('click', (ev) => {
    ev.preventDefault();
    tauri?.opener.openUrl(url).catch(() => {});
  });
}
