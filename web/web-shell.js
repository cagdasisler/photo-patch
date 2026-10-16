'use strict';

// Web-only additions to the editor page: links to the desktop app and a privacy note.
(() => {
  const RELEASES_URL = 'https://github.com/cagdasisler/photo-patch/releases/latest';
  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /><path d="m9 8 3 3 3-3" /><path d="M12 11V5" /></svg>';

  const getApp = document.createElement('a');
  getApp.className = 'web-get-app';
  getApp.href = RELEASES_URL;
  getApp.target = '_blank';
  getApp.rel = 'noopener';
  getApp.title = 'Download Photo Patch for Windows: an installer, or a portable .exe with nothing to install';
  getApp.innerHTML = `${ICON_DOWNLOAD}<span>Download for Windows</span>`;
  document.getElementById('stage').append(getApp);

  const note = document.createElement('p');
  note.className = 'web-note';
  note.innerHTML = `
    <span>Your pictures stay on this device. Nothing is uploaded.</span>
    <span>Prefer a desktop app? <a href="${RELEASES_URL}" target="_blank" rel="noopener">Download Photo Patch for Windows</a></span>`;
  document.querySelector('.empty-card').append(note);
})();
