// AC6: the wakes that come from the social store (contract section 3.2): W-DM, W-HALL and W-CALL. The feed's own wakes (W-CLASH,
// W-THREAT) come from AC6a; W-PULSE is the gate's own; W-READY and W-QUEUE are the brain's hints. Each wake is delivered ONCE, at the
// first decision whose bell is at or after the bell it happened in, so a message that lands after the step of its own bell is not lost
// and a repeated poll does not count it twice. Everything read here is public (the rows `GET /f/ai/talk` serves, the council's
// public state): no ballot, no sealed Call, no client address.
//
//   W-DM    a direct message to the AI, counted at most once per sender per 6 bells (weight 2)
//   W-HALL  a nation-channel message that names the AI, or a motion in its nation (weight 1)
//   W-CALL  a Strike Order adopted and sealed in the AI's nation, while members may still follow it: [follow_from, S - 1] (weight 3)
//
// The gate caps W-DM + W-HALL at 2 together (the social cap), so social traffic alone never opens a session; W-CALL does.
export const DM_WINDOW = 6;
const KIND_MOTION = 1;
const CH_NATION = 1;
const CH_DIRECT = 3;

export const WEIGHTS = Object.freeze({ 'W-DM': 2, 'W-HALL': 1, 'W-CALL': 3 });

const norm = s => String(s ?? '').normalize('NFKC').toLowerCase();

/**
 * createSocialWakes({rows, council, roster, nameOf, lookback}) -> {wakes(tag, bell) -> [{code, weight, bell, seq, ...}]}
 *   rows() -> every accepted talk row in order ({bell, wallet, tag, channel, target, kind, ref, text})
 *   council: the council store ({latest(f), publicOf(f, k)}) or null
 */
export function createSocialWakes({ rows, council = null, roster, nameOf, lookback = 8 } = {}) {
  const delivered = new Map(); // tag -> Set of keys
  const lastDm = new Map(); // "tag|senderWallet" -> bell of the last W-DM counted
  const names = new Map();
  const nameWords = tag => {
    if (!names.has(tag)) {
      const n = nameOf(tag);
      names.set(tag, [n.en, n.ja].map(norm).filter(x => x.length >= 2));
    }
    return names.get(tag);
  };

  function wakes(tag, bell) {
    const me = roster.byTag?.(tag);
    if (!me) return [];
    let seen = delivered.get(tag);
    if (!seen) delivered.set(tag, (seen = new Set()));
    const out = [];
    const take = (key, w) => { if (seen.has(key)) return; seen.add(key); out.push(w); };
    for (const r of rows()) {
      if (r.bell > bell || r.bell < bell - lookback || r.tag === tag) continue;
      const id = r.inner ?? r.id;
      if (r.channel === CH_DIRECT && r.target === me.wallet && Number(r.kind ?? 0) === 0) {
        const k = `dm:${id}`;
        if (seen.has(k)) continue;
        const sk = `${tag}|${r.wallet}`;
        const prev = lastDm.get(sk);
        if (prev !== undefined && r.bell - prev < DM_WINDOW) { seen.add(k); continue; } // the same sender within 6 bells counts once
        lastDm.set(sk, r.bell);
        take(k, { code: 'W-DM', weight: WEIGHTS['W-DM'], bell: r.bell, seq: String(id), sender: r.tag ?? null });
      } else if (r.channel === CH_NATION && r.target === me.faction) {
        const motion = Number(r.kind ?? 0) === KIND_MOTION;
        const named = !motion && nameWords(tag).some(w => norm(r.text).includes(w));
        if (motion || named) take(`hall:${id}`, { code: 'W-HALL', weight: WEIGHTS['W-HALL'], bell: r.bell, seq: String(id), motion });
      }
    }
    const P = council?.latest?.(me.faction);
    const pub = P && P.outcome?.adopted && P.call ? council.publicOf(me.faction, P.period) : null;
    if (pub?.adopted && pub.sealed && bell >= pub.follow_from && bell < pub.strike_bell) {
      take(`call:${P.period}`, { code: 'W-CALL', weight: WEIGHTS['W-CALL'], bell: pub.follow_from, seq: `call-${P.period}`, period: P.period });
    }
    return out;
  }
  return { wakes };
}
