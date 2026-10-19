import { escapeHtml } from './render.js';
import { SCOPE_LABELS } from '../sync/scope.js';

export function renderViewerHeader({ scope, updatedAt, label }) {
  const who = label ? escapeHtml(label) : 'her';
  const when = updatedAt ? `as of ${escapeHtml(updatedAt)}` : 'nothing received yet';
  const what = scope ? escapeHtml(SCOPE_LABELS[scope] ?? scope) : '';
  return '<section class="card viewer-header">'
    + `<h2>${who}'s cycle</h2>`
    + `<p class="viewer-freshness">${when} · read-only</p>`
    + (what ? `<p class="viewer-scope">${what}</p>` : '')
    + '</section>';
}
