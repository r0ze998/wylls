// Builds test/fixtures/ai-gguf-control-tokens.json for T-S1 (contract section 4.6): every CONTROL (3) and
// USER_DEFINED (4) token of the pinned model, read from the GGUF metadata (tokenizer.ggml.tokens and
// tokenizer.ggml.token_type). Reads only the header of the file (the first MAX_HEADER bytes), never the tensors.
//   node test/fixtures/ai-gguf-tokens-build.mjs --model <path.gguf> [--sha256 <hex>] [--out <file>]
// Without --sha256 it hashes the whole model file (about 14.6 GB; a minute or two). The model file is read-only.
import { openSync, readSync, closeSync, createReadStream, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, basename } from 'node:path';

const MAX_HEADER = 160 * 1024 * 1024;
export const TOKEN_TYPE = { 1: 'normal', 2: 'unknown', 3: 'control', 4: 'user_defined', 5: 'unused', 6: 'byte' };

/** Parse GGUF metadata from a Buffer holding the file's head. Returns {version, kv: Map, tensorCount}. Arrays of strings/ints are returned whole. */
export function parseGgufHead(buf) {
  let o = 0;
  const need = (n) => {
    if (o + n > buf.length) throw new Error(`GGUF header longer than the ${buf.length} bytes read`);
  };
  const u32 = () => (need(4), (o += 4), buf.readUInt32LE(o - 4));
  const u64 = () => (need(8), (o += 8), Number(buf.readBigUInt64LE(o - 8)));
  const str = () => {
    const n = u64();
    need(n);
    o += n;
    return buf.toString('utf8', o - n, o);
  };
  if (buf.toString('latin1', 0, 4) !== 'GGUF') throw new Error('not a GGUF file');
  o = 4;
  const version = u32();
  if (version < 2) throw new Error(`GGUF version ${version} not supported`);
  const tensorCount = u64();
  const kvCount = u64();
  const scalar = (t) => {
    switch (t) {
      case 0: return (need(1), buf.readUInt8(o++));
      case 1: return (need(1), buf.readInt8(o++));
      case 2: return (need(2), (o += 2), buf.readUInt16LE(o - 2));
      case 3: return (need(2), (o += 2), buf.readInt16LE(o - 2));
      case 4: return u32();
      case 5: return (need(4), (o += 4), buf.readInt32LE(o - 4));
      case 6: return (need(4), (o += 4), buf.readFloatLE(o - 4));
      case 7: return (need(1), buf.readUInt8(o++) !== 0);
      case 8: return str();
      case 10: return u64();
      case 11: return (need(8), (o += 8), Number(buf.readBigInt64LE(o - 8)));
      case 12: return (need(8), (o += 8), buf.readDoubleLE(o - 8));
      default: throw new Error(`GGUF value type ${t}`);
    }
  };
  const value = (t) => {
    if (t !== 9) return scalar(t);
    const it = u32();
    const n = u64();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = scalar(it);
    return out;
  };
  const kv = new Map();
  for (let i = 0; i < kvCount; i++) {
    const k = str();
    const t = u32();
    kv.set(k, value(t));
  }
  return { version, tensorCount, kv };
}

export function readGgufHead(path, bytes = MAX_HEADER) {
  const fd = openSync(path, 'r');
  try {
    const size = Math.min(bytes, statSync(path).size);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return parseGgufHead(buf);
  } finally {
    closeSync(fd);
  }
}

export function controlTokens(head) {
  const tokens = head.kv.get('tokenizer.ggml.tokens');
  const types = head.kv.get('tokenizer.ggml.token_type');
  if (!Array.isArray(tokens) || !Array.isArray(types) || tokens.length !== types.length) throw new Error('GGUF has no tokenizer.ggml.tokens / token_type pair');
  const out = [];
  tokens.forEach((t, id) => {
    if (types[id] === 3 || types[id] === 4) out.push({ id, token: t, type: TOKEN_TYPE[types[id]] });
  });
  return { vocab_size: tokens.length, tokens: out };
}

const sha256File = (path) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const model = arg('--model');
  if (!model) throw new Error('usage: --model <path.gguf> [--sha256 <hex>] [--out <file>]');
  const head = readGgufHead(model);
  const { vocab_size, tokens } = controlTokens(head);
  const sha = arg('--sha256') ?? (await sha256File(model));
  const out = {
    v: 1,
    model_file: basename(model),
    model_sha256: sha,
    gguf_version: head.version,
    tokenizer_model: head.kv.get('tokenizer.ggml.model') ?? null,
    vocab_size,
    note: 'every CONTROL (3) and USER_DEFINED (4) token of the model vocabulary, read from the GGUF metadata; contract section 4.6 T-S1',
    tokens,
  };
  const dest = arg('--out') ?? fileURLToPath(new URL('./ai-gguf-control-tokens.json', import.meta.url));
  writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  console.log(`${tokens.length} control/user-defined tokens of ${vocab_size}; sha256 ${sha}; wrote ${dest}`);
}
