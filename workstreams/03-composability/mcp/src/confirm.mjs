// What prepare_caravan puts before the person (written 2026-11-17 under an execution pause; NOT run). Pure: no imports,
// no I/O. It only words what prepare already knew — the plan's cargo, road time, settle fee and who pays it, and the
// agent's state behind `warnings` — so that the one text the server instructions say to show (`confirm`) does not drop
// the cost and the refusals. Nothing here decides, charges, signs or sends: send_caravan's checks are unchanged.
//
// Costs, as the code has them (not measured here):
//   - the transaction fee, the Caravan account's rent and the settle fee are paid by the relay's fee payer: the agent
//     path goes through the relay's sponsor() (permutation-gateway/src/frontier/agent/gateway.mjs), whose drain guard
//     allows SendCaravan rent(Caravan) + CARAVAN_FEE (shapes.mjs); the agent wallet's terms say networkFees
//     {paidBy: 'relay', recordedOnly: true};
//   - the settle fee (plan.feeLamports, CARAVAN_FEE) is held in the Caravan and paid to whoever settles it
//     (permutation-frontier/src/proc/caravan.rs); it is not the transaction fee;
//   - the agent wallet may hold a per-action price (prices.game[SendCaravan], '0' when none is set); this server does
//     not read it, so it is said to be not known here — never free.

/** The value of cost.agentPrice: this server does not read the agent wallet's per-action price. */
export const AGENT_PRICE_NOT_READ = 'not read by this server: the relay\'s agent wallet may set a price per action (workstream 05); the agent\'s budget is in get_village_status';

/**
 * @param {{from: string, to: string, cargoNamed: object, estimatedSecs: number, feeLamports: string}} plan  Game.plan's result
 * @param {object} agent  the agent view prepare already read (policy.allowed, mode, delegation)
 * @returns {{confirm: string, warnings: string[], refusals: string[]}}
 */
export function prepareNotice(plan, agent) {
  const warnings = [], refusals = [];
  // The same three checks and the same warning texts as before; `refusals` names their codes for the confirm text.
  if (!(agent?.policy?.allowed ?? []).includes('SendCaravan')) { refusals.push('ActionNotAllowed'); warnings.push('The agent\'s policy does not allow SendCaravan: send_caravan will be refused (ActionNotAllowed) until the owner allows the transport group (and the relay has patch 0005).'); }
  if (agent?.mode !== 'auto') { refusals.push('AgentStopped'); warnings.push('The agent is stopped (manual): send_caravan will be refused (AgentStopped).'); }
  if (agent?.delegation && !agent.delegation.delegated) { refusals.push('SessionNotDelegated'); warnings.push('The village is not delegated to the agent on chain: send_caravan will be refused (SessionNotDelegated).'); }
  const cargo = Object.entries(plan.cargoNamed ?? {}).map(([r, n]) => `${n} ${r}`).join(', ');
  const confirm = [
    `Send a caravan from ${plan.from} to ${plan.to} with ${cargo} (about ${Math.round(plan.estimatedSecs / 60)} min on the road; it cannot be recalled and can be raided).`,
    `The transaction fee, the caravan's account rent and a ${plan.feeLamports}-lamport settle fee (held in the caravan for whoever settles it) are paid by the relay's fee payer (sponsored).`,
    'An agent-wallet price for this action, if the relay sets one, is not known here (the agent\'s budget: get_village_status).',
    ...(refusals.length ? [`As things stand, send_caravan would be refused: ${refusals.join(', ')} (see warnings); the server checks again at send.`] : []),
  ].join(' ');
  return { confirm, warnings, refusals };
}
