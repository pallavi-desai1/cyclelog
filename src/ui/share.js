import { escapeHtml } from './render.js';
import { SCOPES, SCOPE_LABELS } from '../sync/scope.js';
import { describePush } from '../sync/share.js';

// §7.2: the owner's device writes on save, debounced and coalesced.
export const PUSH_DEBOUNCE_MS = 5000;

const scopeSelect = current => {
  const options = SCOPES.map(scope => (
    `<option value="${scope}"${scope === current ? ' selected' : ''}>`
    + `${escapeHtml(SCOPE_LABELS[scope])}</option>`
  )).join('');
  return `<label for="share-scope">What he sees</label>`
    + `<select id="share-scope">${options}</select>`;
};

// §7.7 and §7.5, on screen before the first grant rather than in a README.
const TERMS = '<p class="share-terms">Google stores the file but cannot read it:'
  + ' it is encrypted on this phone and the key never reaches them. They can see'
  + ' that a file exists, when it changes and when he reads it.'
  + ' Stopping sharing stops the future, not the past — whatever his app has'
  + ' already cached stays on his phone, and he still holds the key for it.</p>';

export function renderShareCard({ state, fingerprint, ownerUid }) {
  const parts = ['<section class="card share"><h3>Share with a partner</h3>'];

  if (state.key === null) {
    parts.push('<p>He gets a read-only view on his own phone. Nothing is shared until you set this up.</p>');
    parts.push(scopeSelect(state.scope));
    parts.push(TERMS);
    parts.push('<button id="share-start" type="button">Start sharing</button>');
    parts.push('<p id="share-error" role="alert"></p></section>');
    return parts.join('');
  }

  parts.push(`<p class="share-status">${escapeHtml(describePush(state.lastPush, state.scope))}</p>`);
  if (ownerUid) {
    parts.push('<p>Your sync id, which he types into his app:</p>');
    parts.push(`<p><code id="share-uid">${escapeHtml(ownerUid)}</code></p>`);
  }
  parts.push('<p>His key — he types this once, in person. Check the six characters'
    + ' beside it match on both screens.</p>');
  parts.push(`<code id="share-key">${escapeHtml(state.key)}</code>`);
  parts.push(`<p class="share-fingerprint">Fingerprint: <strong>${escapeHtml(fingerprint)}</strong></p>`);
  parts.push('<button id="share-copy" type="button" class="secondary">Copy key</button>');

  parts.push(scopeSelect(state.scope));

  parts.push('<h4>Who can see it</h4>');
  if (state.viewers.length === 0) {
    parts.push('<p id="share-viewers">Nobody yet — add his sync id below.</p>');
  } else {
    const rows = state.viewers.map(viewer => (
      `<li>${escapeHtml(viewer.label || viewer.uid)} — granted ${escapeHtml(viewer.grantedAt)}`
      + ` <button type="button" class="secondary" data-revoke="${escapeHtml(viewer.uid)}">Remove</button></li>`
    )).join('');
    parts.push(`<ul id="share-viewers">${rows}</ul>`);
  }

  parts.push('<label for="share-viewer-uid">His sync id</label>');
  parts.push('<input id="share-viewer-uid" type="text" autocapitalize="off" spellcheck="false">');
  parts.push('<label for="share-viewer-label">What to call him</label>');
  parts.push('<input id="share-viewer-label" type="text">');
  parts.push('<button id="share-add" type="button">Add viewer</button>');

  parts.push(TERMS);
  parts.push('<button id="share-rekey" type="button" class="secondary">New key</button>');
  parts.push('<button id="share-stop" type="button" class="secondary">Stop sharing</button>');
  parts.push('<p id="share-error" role="alert"></p></section>');
  return parts.join('');
}
