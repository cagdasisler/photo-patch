'use strict';

// Web-only additions to the editor page. Every visit opens on a welcome screen that
// recommends the Windows app first; the browser version is the fallback.
(() => {
  const release = (() => {
    try {
      return JSON.parse(document.getElementById('app-release').textContent);
    } catch {
      return { page: 'https://github.com/cagdasisler/photo-patch/releases/latest' };
    }
  })();

  const ua = navigator.userAgent;
  const isPhoneOrTablet =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isWindows = !isPhoneOrTablet && /Windows/i.test(ua);
  const isMac = !isPhoneOrTablet && /Macintosh|Mac OS X/i.test(ua);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;

  const LOGO =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="3 2.4" /><rect x="9.5" y="9.5" width="12" height="12" rx="2.5" class="solid" /></svg>';
  const ICON_WINDOWS =
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="filled"><path d="M3 5.5 10.5 4.5v7H3zM11.5 4.4 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z" /></svg>';
  const ICON_DESKTOP =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /><path d="m9 8 3 3 3-3" /><path d="M12 11V5" /></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>';
  const ICON_BROWSER =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="M2 9h20" /><path d="M6 6.5h.01" /><path d="M9 6.5h.01" /></svg>';

  // Why the app is the better choice. Each one is something the browser can't do.
  const PERKS = [
    'Open pictures straight from File Explorer',
    'Works with no internet connection',
    'Saves next to your original picture',
    'Keeps your signatures on your PC',
  ];

  /* ---------- Welcome screen ---------- */

  const gate = document.createElement('dialog');
  gate.className = 'web-gate';
  gate.setAttribute('aria-labelledby', 'gate-title');
  document.body.append(gate);

  function downloadLink(kind, className, label, attrs = '') {
    const asset = release[kind];
    if (!asset) {
      return `<a class="${className}" href="${esc(release.page)}" target="_blank" rel="noopener" data-gate="page"${attrs}>${label}</a>`;
    }
    return `<a class="${className}" href="${esc(asset.url)}" target="_blank" rel="noopener" data-gate="download" data-kind="${kind}"${attrs}>${label}</a>`;
  }

  function meta() {
    const parts = ['Free', 'Windows 10 and 11'];
    if (release.version) parts.splice(1, 0, `Version ${esc(release.version)}`);
    if (release.setup) parts.push(megabytes(release.setup.size));
    return parts.join(' · ');
  }

  const continueButton = (primary) =>
    `<button type="button" class="${primary ? 'primary gate-main' : 'gate-continue'}" data-gate="continue"${primary ? ' autofocus' : ''}>
      ${primary ? ICON_BROWSER : ''}Continue in browser
    </button>`;

  function renderChoice() {
    let body;
    if (isWindows) {
      body = `
        <h1 id="gate-title">Get the Photo Patch app</h1>
        <p class="gate-lead">Cover a blemish, hide something in the background, or sign a picture. The free Windows app is the best way to use Photo Patch.</p>
        <ul class="gate-perks">${PERKS.map((p) => `<li>${ICON_CHECK}${p}</li>`).join('')}</ul>
        ${downloadLink('setup', 'primary gate-main', `${ICON_WINDOWS}Download for Windows`, ' autofocus')}
        <p class="gate-meta">${meta()}</p>
        ${release.portable ? downloadLink('portable', 'gate-alt', 'Or get the portable version: nothing to install') : ''}
        <div class="gate-or"><span>Can’t install apps on this computer?</span></div>
        ${continueButton(false)}`;
    } else {
      const where = isMac ? 'You’re on a Mac' : 'You’re on a phone or tablet';
      body = `
        <h1 id="gate-title">Photo Patch is a Windows app</h1>
        <p class="gate-lead">${where}, so use it right here in your browser. It has every feature of the app, and your pictures never leave this device.</p>
        ${isPhoneOrTablet ? '<p class="gate-lead gate-small">It works best on a computer with a mouse and keyboard.</p>' : ''}
        ${continueButton(true)}
        <div class="gate-or"><span>Have a Windows PC?</span></div>
        ${downloadLink('setup', 'gate-alt', `Download the app for Windows${release.setup ? ` (${megabytes(release.setup.size)})` : ''}`)}`;
    }
    gate.innerHTML = `<div class="gate-card"><div class="gate-logo">${LOGO}</div>${body}</div>`;
  }

  function renderDownloading(kind) {
    const asset = release[kind];
    const install =
      kind === 'portable'
        ? '<li><b>Start Photo Patch</b><span>The portable version runs straight away. There’s nothing to install.</span></li>'
        : '<li><b>Install it</b><span>Then open Photo Patch from the Start menu or your desktop.</span></li>';
    gate.innerHTML = `
      <div class="gate-card">
        <div class="gate-logo done">${ICON_CHECK}</div>
        <h1 id="gate-title">Your download has started</h1>
        <ol class="steps gate-steps">
          <li><b>Open the file</b><span>${esc(asset.name)}, in your Downloads folder.</span></li>
          <li><b>If Windows protects your PC</b><span>Click <em>More info</em>, then <em>Run anyway</em>. The app is safe; it just isn’t code-signed yet.</span></li>
          ${install}
        </ol>
        <p class="gate-meta">Download didn’t start? <a href="${esc(asset.url)}" target="_blank" rel="noopener" data-gate="download" data-kind="${kind}">Try again</a></p>
        <div class="gate-or"><span>Want to start right now?</span></div>
        ${continueButton(false)}
      </div>`;
  }

  function openGate() {
    renderChoice();
    if (!gate.open) gate.showModal();
  }

  gate.addEventListener('click', (e) => {
    const target = e.target.closest('[data-gate]');
    if (!target) return;
    const action = target.dataset.gate;
    if (action === 'continue') gate.close();
    // The link starts the download in a new tab, which the browser closes once the file arrives,
    // so a picture being edited here is never navigated away from.
    else if (action === 'download') renderDownloading(target.dataset.kind);
  });

  // The visitor picks one of the buttons; Esc doesn't skip the choice.
  gate.addEventListener('cancel', (e) => e.preventDefault());
  // Editor shortcuts stay off while the welcome screen is up.
  gate.addEventListener('keydown', (e) => e.stopPropagation());
  // Dropping a picture on the welcome screen means "use the browser": the editor opens it.
  gate.addEventListener('drop', () => gate.close());

  /* ---------- Reminders inside the editor ---------- */

  const getApp = document.createElement('button');
  getApp.type = 'button';
  getApp.className = 'web-get-app';
  getApp.title = 'Get the free Photo Patch app for Windows';
  getApp.innerHTML = `${ICON_DESKTOP}<span>Get the app</span>`;
  getApp.addEventListener('click', openGate);
  document.getElementById('stage').append(getApp);

  const note = document.createElement('p');
  note.className = 'web-note';
  note.innerHTML = `
    <span>Your pictures stay on this device. Nothing is uploaded.</span>
    <span>Works best as an app: <button type="button" class="link">get Photo Patch for Windows</button></span>`;
  note.querySelector('button').addEventListener('click', openGate);
  document.querySelector('.empty-card').append(note);

  openGate();
})();
