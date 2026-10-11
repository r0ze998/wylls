// Guards (contract sections 0.2 ports, 7.1 "Guards"): loopback-only URLs, the AI port window, no
// API keys in the environment, and the config hash. "Loopback only" is enforced here, by code: the
// Node permission model does not restrict the network (section 1.3 C1).
// This file names the variables it refuses; it is excluded from the G10 grep for that reason.
import { createHash } from 'node:crypto';

export const AI_PORT_MIN = 41901;
export const AI_PORT_MAX = 41999;
const FORBIDDEN_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const FORBIDDEN_PORTS = [4185, 4190, 4191, 4194, 5185, 5191, 17799, 18899, 26699, 27799, 28899];

export class GuardError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

/** A URL is accepted only when its host is 127.0.0.1 or ::1 (and its protocol is http). */
export function assertLoopbackUrl(url, what = 'url') {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError('BadUrl', `${what}: not a URL`);
  }
  if (u.protocol !== 'http:') throw new GuardError('NotLoopback', `${what}: only http on loopback is allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== '::1') throw new GuardError('NotLoopback', `${what}: host ${host} is not 127.0.0.1 or ::1`);
  return u;
}

/** A listening port must be in 41901-41999 (0 is allowed in tests only: pass {test:true}). 41900 is never bound. */
export function assertAiPort(port, what = 'port', { test = false } = {}) {
  if (test && port === 0) return port;
  const p = Number(port);
  if (!Number.isInteger(p) || p < AI_PORT_MIN || p > AI_PORT_MAX || FORBIDDEN_PORTS.includes(p)) {
    throw new GuardError('BadPort', `${what}: ${port} is outside 41901-41999`);
  }
  return p;
}

/** The llama server may be on any loopback port the config names inside the AI window. */
export function assertLlamaUrl(url, { test = false } = {}) {
  const u = assertLoopbackUrl(url, 'llm url');
  const port = Number(u.port || 80);
  if (!(test && port > 1023)) assertAiPort(port, 'llm port');
  return u;
}

export function assertNoApiKeys(env = process.env) {
  for (const k of FORBIDDEN_ENV) {
    if (env[k]) throw new GuardError('ApiKeyInEnv', `${k} is set: the AI service refuses to run with a paid-API key in its environment`);
  }
}

/** sha256 of the canonical (key-sorted) JSON of a config object. */
export function configHash(config) {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/** Validate the service's ports and URLs in one place; throws GuardError on the first violation. */
export function assertServiceConfig({ herald, llm, mindPort, socialPort, servePort, env = process.env, test = false }) {
  assertNoApiKeys(env);
  assertLoopbackUrl(herald, 'herald');
  assertLlamaUrl(llm, { test });
  for (const [what, p] of [['mind port', mindPort], ['social port', socialPort], ['serve port', servePort]]) {
    if (p != null) assertAiPort(p, what, { test });
  }
}
