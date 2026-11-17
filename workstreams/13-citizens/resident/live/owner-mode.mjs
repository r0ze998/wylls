// The owner's signed mode command for an operator resident's directory, applied WITHOUT constructing a Resident
// (2026-11-17). The same contract as resident.mjs Resident.command for op 'mode' (and nothing else):
//   verifyCommand (permutation-gateway src/frontier/agent/owner-auth.mjs): the owner's wallet signature over the
//     canonical command, its expiry within MAX_COMMAND_MS of owner-auth's own clock (its default; no time is taken
//     from the caller), and its nonce consumed in the ledger's ownerNonces (a replay is refused);
//   the command's owner must be the charter's owner and its agentId the charter's id (NotOwner otherwise);
//   the agent ledger's setMode on the record, then the state saved (createStateStore: a temporary file and a rename),
//     so the nonce is kept even when the mode does not change, as Resident.command saves.
// Narrower than Resident.command, never wider: only {mode: 'auto'|'manual'} (Resident.command turns any other value
// into 'auto'; here it is refused); `withdraw` (which changes the journal) and op 'policy' (which changes the charter)
// stay with the resident and are refused here. No key is read or made: verifying a signature reads only the owner's
// public address. This module signs, sends, funds and authorizes nothing. What 'auto' then allows depends on WHO reads
// the state: the live, non-enacting path (step.mjs, once.mjs) only proposes; but the mode is the agent ledger's own,
// shared with the resident, so a Resident process stepping this directory would act under it as it always does
// (resident.mjs step). 'auto' is therefore not "proposals only" in general.
//
// Not excluded: a resident process running on the same directory at the same time (the existing state file has no
// lock): the last writer wins. Apply it only while no resident process uses the directory.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyCommand } from '../../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { AgentLedger } from '../../../../permutation-gateway/src/frontier/agent/ledger.mjs';
import { createStateStore } from '../../../../permutation-gateway/src/config.mjs';
import { readResidentState } from './resident-state.mjs';
import { existsForHalt } from './factory.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const why = e => String(e?.code ?? e?.message ?? e).slice(0, 80);

/**
 * `dir` the resident's directory (absolute); `wallet` its public address (the ledger record's agent key);
 * `signed` = {command: {op: 'mode', owner, agentId, nonce, expiresAt, params: {mode}}, signature} as the owner signed it.
 * → {ok: true, mode, modeEpoch} | {ok: false, step, why}. A refusal (every step before 'save') writes nothing. A failure at
 * 'save' before the rename leaves the file as it was; one after it (syncing the directory: createStateStore) is still
 * reported as a failure though the new file may be in place, so the state is to be read again, never assumed applied.
 */
export function applyOwnerModeCommand({ dir, wallet, signed }) {
  const command = signed?.command;
  if (!isObj(command) || command.op !== 'mode') return { ok: false, step: 'command', why: "only an owner command with op 'mode' is applied here" };
  const params = command.params;
  if (!isObj(params) || !['auto', 'manual'].includes(params.mode) || Object.keys(params).some(k => k !== 'mode')) return { ok: false, step: 'command', why: "params must be exactly {mode: 'auto'|'manual'} (withdraw and policy stay with the resident)" };
  // the directory as the live reader reads it (versions, owner, policy shape, this wallet); unknown is refused
  const pre = readResidentState({ dir, wallet, fs: { readText: p => readFileSync(p, 'utf8'), exists: existsForHalt } });
  if (pre.stop?.why === 'state-unknown') return { ok: false, step: 'state', why: `the resident's state is not known: ${pre.stop.detail ?? ''}`.slice(0, 160) };
  let charter;
  try { charter = JSON.parse(readFileSync(path.join(dir, 'charter.json'), 'utf8')); } catch (e) { return { ok: false, step: 'charter', why: why(e) }; }
  const store = createStateStore(path.join(dir, 'state.json'));
  try { store.load(); } catch (e) { return { ok: false, step: 'state', why: why(e) }; }
  const rec0 = store.state?.agentWallet?.agents?.[charter.id];
  if (!isObj(rec0) || rec0.agentKey !== wallet || rec0.owner !== charter.owner?.address) return { ok: false, step: 'state', why: 'the state changed since it was read, or is for another wallet or owner' };
  let ledger;
  try { ledger = new AgentLedger({ store }); } catch (e) { return { ok: false, step: 'ledger', why: why(e) }; }
  try { verifyCommand({ command, signature: signed.signature }, { op: 'mode', nonces: ledger.db.ownerNonces }); }
  catch (e) { return { ok: false, step: 'verify', why: why(e) }; }   // nothing saved: the nonce is not consumed on disk
  if (command.owner !== charter.owner.address || command.agentId !== charter.id) return { ok: false, step: 'owner', why: 'NotOwner' };
  try {
    ledger.setMode(charter.id, params.mode);
    ledger.save();   // also when the mode was already this one: the nonce is kept (as Resident.command saves)
  } catch (e) { return { ok: false, step: 'save', why: why(e), readAgain: true }; }   // not reported as applied: read the state again
  const rec = ledger.get(charter.id);
  return { ok: true, mode: rec.mode, modeEpoch: rec.modeEpoch };
}
