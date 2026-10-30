// Runs residents and scripted people in one test world, saved to disk after
// every bell so that any part (the world, a resident) can be restarted from
// its files. People use the same ports as residents: their own key, the same
// view, the same signed actions and board posts.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStateStore } from '../../../permutation-gateway/src/config.mjs';
import { addressOf, loadOrCreateKey, newKeypair, signRecord } from '../resident/keys.mjs';
import { Resident, safeFallback } from '../resident/resident.mjs';
import { localMemory } from '../resident/ports/memory.mjs';
import { testWorldBoard, testWorldExecution } from '../resident/ports/execution.mjs';
import { Board } from './board.mjs';
import { JOIN_DOMAIN, TestWorld } from './testworld.mjs';

/** The world and its board, from `dir` if saved there. */
export function openWorld(dir) {
  mkdirSync(dir, { recursive: true });
  const store = createStateStore(path.join(dir, 'world.json'));
  const saved = store.load();
  const world = saved ? TestWorld.fromJSON(saved.world) : new TestWorld();
  const board = new Board(world, saved ? structuredClone(saved.board) : null);
  return { world, board, save: () => store.save({ world: world.toJSON(), board: board.toJSON() }) };
}

/** The ports a participant gets: nothing but its own key's view, actions and posts. */
export function portsFor(world, board, keypair) {
  return {
    observe: async () => ({ world: world.view(addressOf(keypair)), board: board.view() }),
    join: async record => world.join(record),
    execution: testWorldExecution(world, keypair),
    board: testWorldBoard(board, keypair),
  };
}

/** A resident with its own memory file and the given provider. */
export function openResident(dir, { world, board, provider, crash = null, fallback = safeFallback }) {
  // The resident makes or reads its own key; its ports are bound to that key.
  const r = new Resident({ dir, ports: {}, crash });
  r.ports = { ...portsFor(world, board, r.keypair), provider, memory: localMemory(path.join(dir, 'episodes.jsonl')), fallback };
  return r;
}

/** A scripted person: a key, a village, and `script(bell, me)` run every bell. */
export class Person {
  constructor({ name, pos, world, board, script, keyFile = null }) {
    this.name = name; this.pos = pos; this.script = script;
    this.keypair = keyFile ? loadOrCreateKey(keyFile) : newKeypair();
    this.address = addressOf(this.keypair);
    this.ports = portsFor(world, board, this.keypair);
    this.world = world; this.board = board;
    this.log = [];
    this.n = 0;
  }

  get citizen() { return this.world.s.byKey[this.address] ?? null; }

  join() {
    const body = { name: this.name, pos: this.pos, key: this.address };
    return this.world.join({ body, sig: signRecord(JOIN_DOMAIN, body, this.keypair) });
  }

  async post(body) { const r = await this.ports.board.post(body); this.log.push({ bell: this.world.bell, post: body, r }); return r; }

  async send(name, fields) {
    const r = await this.ports.execution.submit({ idempotencyKey: `${this.name}-b${this.world.bell}-${++this.n}`, action: { name, fields } });
    this.log.push({ bell: this.world.bell, send: { name, fields }, r });
    return r;
  }

  async act(bell) { if (this.script) await this.script(bell, this); }
}
