// The fixed banner (contract §9.4 items 2 and 4): "LOCAL TEST CHAIN · AI citizens are labelled · recorded <date> ·
// run <id>". It is part of council.html (so it exists before any script runs) and this module only fills in the
// run id, the date and the cluster check. It cannot be hidden: when the herald reports a cluster other than
// `localnet` the banner turns into a warning instead of disappearing; when the herald has not answered yet the
// banner still says "local test chain".

/** The bell containing chain time `latestUnix`, from /h/season (`genesisTs`, `bellSecs`), or null before genesis or without data. */
export function currentBell(season) {
  const g = Number(season?.genesisTs), s = Number(season?.bellSecs), u = Number(season?.latestUnix);
  if (!Number.isFinite(g) || !Number.isFinite(s) || s <= 0 || !Number.isFinite(u) || u < g) return null;
  return Math.floor((u - g) / s);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `{state: 'local'|'unknown'|'not_local', cluster, date, runId}`. `recorded` is an optional YYYY-MM-DD from the page's query. */
export function bannerModel({ season = null, commitments = null, recorded = null } = {}) {
  const cluster = typeof season?.cluster === 'string' ? season.cluster : null;
  const state = cluster === null ? 'unknown' : cluster === 'localnet' ? 'local' : 'not_local';
  let date = typeof recorded === 'string' && DATE.test(recorded) ? recorded : null;
  const cu = Number(commitments?.created_unix);
  if (!date && Number.isFinite(cu) && cu > 0) date = new Date(cu * 1000).toISOString().slice(0, 10);
  const runId = typeof commitments?.run_id === 'string' ? commitments.run_id.slice(0, 40) : null;
  return { state, cluster, date, runId };
}

export function renderBanner(ctx, m) {
  const { h, t } = ctx;
  if (m.state === 'not_local') return h('span', { class: 'banner-warn' }, t('banner.not_local', { cluster: String(m.cluster).slice(0, 24) }));
  const parts = [m.state === 'unknown' ? t('banner.no_herald') : t('banner.localnet'), t('banner.labelled')];
  if (m.date) parts.push(t('banner.recorded', { date: m.date }));
  if (m.runId) parts.push(t('banner.run', { id: m.runId }));
  return h('span', { class: 'banner-line' }, parts.join(' · '));
}
