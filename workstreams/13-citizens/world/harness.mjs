// Runs residents and scripted people in one test world, saved to disk after
// every bell so that any part (the world, a resident) can be restarted from
// its files. People use the same ports as residents: their own key, the same
// view, the same signed actions and board posts.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStateStore } from '../../../permutation-gateway/src/config.mjs';
import { toIdentity } from '../resident/keys.mjs';
import { identityFor, KEYLESS } from './identity.mjs';
import { Resident, safeFallback } from '../resident/resident.mjs';
import { localMemory } from '../resident/ports/memory.mjs';
import { testWorldBoard, testWorldExecution } from '../resident/ports/execution.mjs';
import { MOCK_CLOCK, MOCK_WORLD } from '../resident/frame.mjs';
import { Board } from './board.mjs';
import { JOIN_DOMAIN, TestWorld } from './testworld.mjs';

/** The world and its board, from `dir` if saved there. */
export function openWorld(dir) {
  mkdirSync(dir, { recursive: true });
  const store = createStateStore(path.join(dir, 'world.json'));
  const saved = store.load();
  const world = saved ? TestWorld.fromJSON(saved.world) : new TestWorld(null, { keyless: KEYLESS });
  const board = new Board(world, saved ? structuredClone(saved.board) : null);
  return { world, board, save: () => store.save({ world: world.toJSON(), board: board.toJSON() }) };
}

/** The ports a participant gets: nothing but its own key's view, actions and posts. */
export function portsFor(world, board, who) {
  const id = toIdentity(who);
  return {
    // `since`: {events: last event sequence read, boardBell: requests changed since this bell}; without it, everything.
    observe: Object.assign(async (_, since = {}) => ({ world: world.view(id.address, { since: since.events ?? 0 }), board: board.view({ sinceBell: since.boardBell ?? 0 }) }),
      // Whose world and clock `world.bell` is: the test world's own turn counter, not the game's Season bell (08/09).
      { world: MOCK_WORLD, clock: MOCK_CLOCK }),
    join: async record => world.join(record),
    execution: testWorldExecution(world, id),
    board: testWorldBoard(board, id),
  };
}

/**
 * A resident with its own memory file and the given provider. `wrapMemory(port, resident)` may wrap the memory port
 * each time the resident is (re)opened (workstream 12's mirror: adapters/ws13-resident.mjs `mirrorMemoryPort`); it
 * must answer what the port answers. `costFor(resident)` may give the cost port the same way.
 */
export function openResident(dir, { world, board, provider, crash = null, fallback = safeFallback, wrapMemory = null, costFor = null, wire = null }) {
  // The resident makes or reads its own key; its ports are bound to that key.
  const r = new Resident({ dir, ports: {}, crash, identity: KEYLESS ? identityFor(path.basename(dir)) : null });
  r.ports = { ...portsFor(world, board, r.identity), provider, memory: localMemory(path.join(dir, 'episodes.jsonl')), fallback };
  if (wrapMemory) r.ports.memory = wrapMemory(r.ports.memory, r);
  // `costFor(resident)`: the cost port at every (re)open (workstream 5's ledger: ports/ws05-cost.mjs); none: flat.
  if (costFor) r.ports.cost = costFor(r);
  // `wire(resident)`: anything else at every (re)open, last (workstream 4's registry as the execution port, …).
  if (wire) wire(r);
  return r;
}

/** A scripted person: a key, a village, and `script(bell, me)` run every bell. */
export class Person {
  constructor({ name, pos, world, board, script, keyFile = null }) {
    this.name = name; this.pos = pos; this.script = script;
    this.identity = identityFor(name, keyFile);
    this.keypair = this.identity.keypair;
    this.address = this.identity.address;
    this.ports = portsFor(world, board, this.identity);
    this.world = world; this.board = board;
    this.log = [];
    this.n = 0;
  }

  get citizen() { return this.world.s.byKey[this.address] ?? null; }

  join() {
    const body = { name: this.name, pos: this.pos, key: this.address };
    return this.world.join({ body, sig: this.identity.sign(JOIN_DOMAIN, body) });
  }

  async post(body) { const r = await this.ports.board.post(body); this.log.push({ bell: this.world.bell, post: body, r }); return r; }

  async send(name, fields) {
    const r = await this.ports.execution.submit({ idempotencyKey: `${this.name}-b${this.world.bell}-${++this.n}`, action: { name, fields } });
    this.log.push({ bell: this.world.bell, send: { name, fields }, r });
    return r;
  }

  async act(bell) { if (this.script) await this.script(bell, this); }
}
