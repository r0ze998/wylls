// Read-only, public evidence from workstream 12 for a workstream 13 caller.
// This is deliberately NOT a MemoryPort: no append/recall/all and no trust or
// decision conversion. The resident's current mock Board outcomes are not
// execution attestations and must never become verified failures here.
//
// The resolver and world bell must come from workstreams 4/8 when connected.
// Until then, this sidecar can be exercised only with explicit fixtures. It
// does not use the resident's wallet as a workstream 12 principal by guess.
import { memoryLines } from '../../../12-memory/src/view.mjs';

const PRINCIPAL = /^[A-Za-z0-9_-]{1,32}$/;
const PUBLIC_VIEWER = Object.freeze({ tag: null, nation: null });

export function ws12PublicEvidence(memory, { resolvePrincipal = null } = {}) {
  if (typeof memory?.knowledge !== 'function') throw new TypeError('workstream 12 knowledge() is required');
  if (resolvePrincipal !== null && typeof resolvePrincipal !== 'function') throw new TypeError('resolvePrincipal must be a function');

  return Object.freeze({
    kind: 'ws12-public-evidence-readonly',
    read({ counterparty, worldBell, observedBy = worldBell }) {
      if (!Number.isSafeInteger(worldBell) || worldBell < 0 || !Number.isSafeInteger(observedBy) || observedBy < 0)
        throw new TypeError('worldBell and observedBy must be nonnegative world bells');
      if (typeof memory.world?.cluster !== 'string' || typeof memory.world?.world_id !== 'string')
        return { status: 'world_unverified', lines: [] };
      // A 13 wallet address is not a 12 principal. No resolver means no claim.
      const mapping = resolvePrincipal?.(counterparty, worldBell) ?? null;
      if (!mapping || !PRINCIPAL.test(mapping.principal) || typeof mapping.source !== 'string' || !mapping.source)
        return { status: 'identity_unverified', lines: [] };

      // tag and nation are impossible party/nation identifiers, so only public
      // records enter the fold. This never exposes private or nation evidence.
      const knowledge = memory.knowledge(PUBLIC_VIEWER, worldBell, { observedBy });
      return {
        status: 'ok',
        lines: memoryLines(knowledge, [mapping.principal]).map(line => ({
          about: line.about, epistemic: line.epistemic, text: line.text,
          sources: [...line.sources], identitySource: mapping.source,
        })),
      };
    },
  });
}
