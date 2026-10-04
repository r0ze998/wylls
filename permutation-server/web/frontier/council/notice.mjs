// Notices (contract §6.8 item 1, §11.5 AC7): the first-post data notice, and "You are writing to an AI citizen" in the
// compose box. Also the plain-language text of a refusal code of the social service (§6.2 rule 7).
import { pick } from './lang.mjs';
import { tplNodes } from './parts.mjs';

export const NOTICE_KEY = 'council-first-post-notice';

/** Has this browser accepted the notice? (try/catch: private windows and blocked storage give "no", never an error.) */
export function noticeAccepted(storage = globalThis.localStorage) {
  try { return storage?.getItem(NOTICE_KEY) === '1'; } catch { return false; }
}
export function acceptNotice(storage = globalThis.localStorage) {
  try { storage?.setItem(NOTICE_KEY, '1'); return true; } catch { return false; }
}

/**
 * What the compose box says about the recipient. A direct message to a roster AI is "writing to an AI citizen"
 * (named); the nation and world channels are read by AI citizens too (a weaker line). The roster decides, never a
 * flag in a file.
 */
export function composeNotice(index, { channel = 'nation', recipientWallet = '' } = {}) {
  if (channel === 'direct') {
    const a = index.aiByWallet(recipientWallet);
    if (a) return { level: 'ai', name: a.name, tag: a.tag };
    return { level: 'none', name: null, tag: null };
  }
  return { level: index.ai.length ? 'channel' : 'none', name: null, tag: null };
}

/** Plain text of a refusal: the code's sentence, never the server's free text. */
export function refusalText(t, code) {
  const key = `err.${code}`;
  const s = t(key);
  return s === key ? t('err.unknown', { code: String(code ?? '?').slice(0, 40) }) : s;
}

export function renderFirstPostNotice(ctx, { onAccept }) {
  const { h, t } = ctx;
  return h('div', { class: 'notice', role: 'note' },
    h('h4', null, t('notice.title')),
    h('p', null, t('notice.body1')), h('p', null, t('notice.body2')), h('p', null, t('notice.body3')),
    h('button', { type: 'button', class: 'btn', on: { click: onAccept } }, t('notice.accept')));
}

export function renderComposeNotice(ctx, model) {
  const { h, t, lang } = ctx;
  if (model.level === 'ai') {
    const nm = pick(model.name, lang);
    const aiBadge = h('span', { class: 'badge badge-ai', title: t('badge.ai') }, t('badge.ai_short'));
    return h('div', { class: 'compose-notice compose-notice-ai', role: 'note' },
      h('strong', null, t('compose.to_ai')), ' ',
      tplNodes(t('compose.to_ai_detail', { name: '{name}' }), { name: h('span', { class: 'actor' }, h('span', { class: 'actor-name' }, nm), ' ', aiBadge) }));
  }
  if (model.level === 'channel') return h('div', { class: 'compose-notice', role: 'note' }, t('compose.to_channel_ai'));
  return h('div', { class: 'compose-notice-empty' });
}
