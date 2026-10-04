// Counters and latency windows for GET /v1/metrics and PUB/metrics/latest.json (contract sections 8.1,
// 10.1). The mind logs hashes and counters, never prompt text (section 6.8). report.mjs (AC9) derives the
// gate numbers from PUB and this snapshot; the names below are the ones it will read.
const pctOf = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

export function createMetrics({ now = Date.now } = {}) {
  const c = {};
  const groups = {};
  const lat = {}; // kind -> {ms: [], slack: []}
  const citedAges = [];
  const started = now();

  const inc = (name, n = 1) => {
    c[name] = (c[name] ?? 0) + n;
  };
  const incGroup = (group, key, n = 1) => {
    groups[group] ??= {};
    groups[group][key] = (groups[group][key] ?? 0) + n;
  };

  return {
    inc,
    incGroup,
    /** one finished call of `kind`: latency and slack to the deadline (negative slack = late) */
    latency(kind, ms, slackMs) {
      lat[kind] ??= { ms: [], slack: [] };
      lat[kind].ms.push(ms);
      if (slackMs != null) lat[kind].slack.push(slackMs);
      if (lat[kind].ms.length > 5000) {
        lat[kind].ms.shift();
        lat[kind].slack.shift();
      }
    },
    citedAge(bells) {
      citedAges.push(bells);
    },
    get: (name) => c[name] ?? 0,
    snapshot({ bell = null, extra = {} } = {}) {
      const latency = {};
      for (const [k, v] of Object.entries(lat)) {
        latency[k] = {
          n: v.ms.length,
          p50: pctOf(v.ms, 50),
          p90: pctOf(v.ms, 90),
          p99: pctOf(v.ms, 99),
          slack_min: v.slack.length ? Math.min(...v.slack) : null,
          slack_negative: v.slack.filter((x) => x < 0).length,
        };
      }
      return {
        v: 1,
        bell,
        uptime_s: Math.round((now() - started) / 1000),
        counters: { ...c },
        groups: JSON.parse(JSON.stringify(groups)),
        latency,
        memory: {
          cited_episode_ages: { n: citedAges.length, max: citedAges.length ? Math.max(...citedAges) : null },
        },
        ...extra,
      };
    },
  };
}
