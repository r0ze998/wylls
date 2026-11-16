// recall over a list of episodes (unique ids, in the order kept): the local memory adapter's rule
// (ports/memory.mjs localMemory.recall), shared with decide-core's preview so both recall the same way.
import { retrieve } from '../../../permutation-gateway/citizens/memory/retrieve.mjs';

export function recallFrom(list, { focus = [], bell }) {
  const byId = new Map(list.map(e => [e.id, e]));
  return retrieve(list, focus, bell + 1).map(id => byId.get(id));
}
