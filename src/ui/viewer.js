import { escapeHtml } from './render.js';
import { SCOPE_LABELS } from '../sync/scope.js';

export function renderViewerHeader({ scope, updatedAt, label, uid = null }) {
  const who = label ? escapeHtml(label) : 'her';
  const when = updatedAt ? `as of ${escapeHtml(updatedAt)}` : 'nothing received yet';
  const what = scope ? escapeHtml(SCOPE_LABELS[scope] ?? scope) : '';
  return '<section class="card viewer-header">'
    + `<h2>${who}'s cycle</h2>`
    + `<p class="viewer-freshness">${when} · read-only</p>`
    + (what ? `<p class="viewer-scope">${what}</p>` : '')
    // His own sync id, permanently. The grant she makes names this value,
    // and pairing again mints a new one — so the moment a refusal says the
    // grant is gone, this is the number she needs to re-grant. Shown only
    // on the setup screen, it was unreadable exactly when it was needed,
    // and the act of going back to read it invalidated the grant again.
    + (uid ? `<p class="viewer-uid">Your sync id: <code>${escapeHtml(uid)}</code></p>` : '')
    + '</section>';
}
