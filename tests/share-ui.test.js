import { describe, it, expect } from 'vitest';
import { renderShareCard, PUSH_DEBOUNCE_MS } from '../src/ui/share.js';

const off = { key: null, scope: 'dates', viewers: [], identity: null, lastPush: null };
const on = {
  key: 'KEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  scope: 'symptoms',
  viewers: [{ uid: 'viewer-one', label: 'partner', grantedAt: '2015-03-26' }],
  identity: { uid: 'owner-uid', refreshToken: 'refresh' },
  lastPush: { at: '2015-03-26', status: 'ok' },
};

describe('before sharing is set up', () => {
  const html = () => renderShareCard({ state: off, fingerprint: '', ownerUid: null });

  it('offers to start', () => {
    expect(html()).toContain('id="share-start"');
  });

  it('shows the three scopes with the narrowest first', () => {
    const options = [...html().matchAll(/<option value="(\w+)"/g)].map(m => m[1]);
    expect(options).toEqual(['dates', 'symptoms', 'everything']);
  });

  it('explains each scope in a sentence rather than a word', () => {
    expect(html()).toMatch(/when your periods were/i);
    expect(html()).toMatch(/written notes/i);
  });

  // §7.5 and §7.7 appear before the first grant, not in a README.
  it('states what the host can see, and that revocation does not reach the past', () => {
    expect(html()).toMatch(/cannot read|ciphertext|cannot see/i);
    expect(html()).toMatch(/already (seen|cached)|stops the future/i);
  });

  it('shows no key and no viewer list yet', () => {
    expect(html()).not.toContain('id="share-key"');
    expect(html()).not.toContain('id="share-viewers"');
  });
});

describe('once sharing is on', () => {
  const html = () => renderShareCard({ state: on, fingerprint: 'A1B2C3', ownerUid: 'owner-uid' });

  it('shows the key with its fingerprint, so two screens can be compared', () => {
    expect(html()).toContain(on.key);
    expect(html()).toContain('A1B2C3');
  });

  it('offers to copy the key rather than making her retype it', () => {
    expect(html()).toContain('id="share-copy"');
  });

  it('shows the current scope as selected', () => {
    expect(html()).toMatch(/<option value="symptoms" selected/);
  });

  it('lists the viewers with their labels and when they were granted', () => {
    expect(html()).toContain('partner');
    expect(html()).toContain('2015-03-26');
    expect(html()).toContain('id="share-viewers"');
  });

  it('offers to revoke each viewer by uid', () => {
    expect(html()).toMatch(/data-revoke="viewer-one"/);
  });

  it('offers to add a viewer, re-key, and stop entirely', () => {
    for (const id of ['share-add', 'share-rekey', 'share-stop']) {
      expect(html(), id).toContain(`id="${id}"`);
    }
  });

  it('says when the last push happened', () => {
    expect(html()).toMatch(/2015-03-26/);
  });

  // Review Focus 3.
  it('says plainly when the last push never left the phone', () => {
    const offline = renderShareCard({
      state: { ...on, lastPush: { at: '2015-03-26', status: 'offline' } },
      fingerprint: 'A1B2C3', ownerUid: 'owner-uid',
    });
    expect(offline).toMatch(/not sent/i);
  });

  it('shows her own uid, which he needs to point his app at her', () => {
    expect(html()).toContain('owner-uid');
  });

  it('escapes a viewer label rather than letting it become markup', () => {
    const nasty = renderShareCard({
      state: { ...on, viewers: [{ uid: 'u', label: '<img src=x>', grantedAt: '2015-03-26' }] },
      fingerprint: 'A1B2C3', ownerUid: 'owner-uid',
    });
    expect(nasty).not.toContain('<img');
  });

  it('prints no null, undefined or NaN', () => {
    expect(html()).not.toMatch(/null|undefined|NaN/);
    expect(renderShareCard({ state: off, fingerprint: '', ownerUid: null }))
      .not.toMatch(/null|undefined|NaN/);
  });

  it('produces balanced markup in both states', () => {
    for (const output of [html(), renderShareCard({ state: off, fingerprint: '', ownerUid: null })]) {
      const selfClosing = (output.match(/<input[^>]*>/g) ?? []).length;
      const opens = (output.match(/<(?!\/)[a-z]/g) ?? []).length - selfClosing;
      expect(opens).toBe((output.match(/<\//g) ?? []).length);
    }
  });
});

describe('the push debounce', () => {
  it('is the five seconds the spec names', () => {
    expect(PUSH_DEBOUNCE_MS).toBe(5000);
  });
});
