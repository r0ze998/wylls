// A short form of a verdict for people and for the comparison table: the
// close, the prize, each goal's status and first reasons, and how many
// independent options each participant had.

export function summary(v) {
  const reasons = rs => (rs ?? []).map(r => r.code);
  return {
    ruleset: v.ruleset.id,
    verdictHash: v.verdictHash.slice(0, 16),
    close: `${v.period.closeAt} (${v.period.closedBy})`,
    prize: `${v.prize.winners.join('+')} [${v.prize.rule}; ${v.prize.status}]`,
    keeps: v.scores.keeps,
    joint: v.achievements.joint.map(j => ({ goal: j.goal, status: j.status, at: j.achievedAt, reasons: reasons(j.reasons), projects: j.projects.map(p => ({ project: p.project, status: p.status, qualifying: p.stages.diversity.qualifying, use: p.stages.use.nations, inputs: Object.fromEntries(Object.entries(p.stages.inputs.perResource).map(([r, t]) => [r, `${t.credited}/${t.required}` + (t.unverified ? ` +${t.unverified}?` : '') + (t.surplus ? ` (+${t.surplus} surplus)` : '') + (t.late ? ` (${t.late} late)` : '')])) })) })),
    national: Object.fromEntries(v.achievements.national.map(n => [n.subject, `${n.goal}:${n.status}`])),
    personal: v.achievements.personal.filter(p => p.status !== 'not_achieved').map(p => `${p.goal}:${p.subject}:${p.status}`),
    refused: v.records.refused.map(r => `${r.id}:${r.code}`),
    gaps: v.records.gaps, conflicts: v.records.conflicts,
    options: Object.fromEntries(Object.entries(v.options.byActor).map(([a, o]) => [a, `${o.independent}/${o.independentWithGoal}`])),
  };
}
