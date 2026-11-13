// Module worker for wide seals: one `sealWideRequest` per message, tagged
// with its id. k and σ live and die inside the request; the reveal half is
// posted back to the page's memory only (structured clone, no storage).
import { sealWideRequest } from './seal-wide.mjs';

if (typeof globalThis.WorkerGlobalScope !== 'undefined' && globalThis instanceof globalThis.WorkerGlobalScope) {
  globalThis.addEventListener('message', e => {
    const { id, ...req } = e.data ?? {};
    const r = sealWideRequest(req);
    globalThis.postMessage(r.ok
      ? { id, ok: true, seal: r.seal, commit: r.commit, ctHash: r.ctHash, sealRoot: r.sealRoot, round: r.round,
        revealPlain: r.reveal.plain, revealSalt: r.reveal.salt }
      : { id, ok: false, code: r.code, error: r.error });
  });
}
