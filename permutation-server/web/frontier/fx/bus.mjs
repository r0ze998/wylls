// The effects bus (UX-DESIGN §8.1): the code that knows an event happened
// (the bell turned, an order was sealed, a clash resolved) emits it here;
// the effects, the sound and the HUD subscribe. Emitters import only this
// file, so a screen never depends on how its event is shown.
//
//   const off = on('bell', e => …);     // one type
//   on('*', (e, type) => …);            // every type
//   emit('bell', {turn: 43});           // → number of listeners called
//
// A listener that throws never stops the others or the emitter: an effect
// is decoration and must not break an action.

/** A bus of its own (tests); the page uses the default one below. */
export function createBus() {
  const map = new Map();
  const list = type => { let l = map.get(type); if (!l) map.set(type, (l = new Set())); return l; };
  const call = (fn, payload, type) => { try { fn(payload, type); return 1; } catch (e) { globalThis.console?.warn?.('fx bus:', type, e); return 0; } };
  return {
    on(type, fn) { list(type).add(fn); return () => { map.get(type)?.delete(fn); }; },
    once(type, fn) { const off = this.on(type, (p, t) => { off(); fn(p, t); }); return off; },
    emit(type, payload = {}) {
      let n = 0;
      for (const fn of [...(map.get(type) ?? [])]) n += call(fn, payload, type);
      for (const fn of [...(map.get('*') ?? [])]) n += call(fn, payload, type);
      return n;
    },
    count(type) { return map.get(type)?.size ?? 0; },
    clear() { map.clear(); },
  };
}

export const bus = createBus();
export const on = (type, fn) => bus.on(type, fn);
export const once = (type, fn) => bus.once(type, fn);
export const emit = (type, payload) => bus.emit(type, payload);
