#!/usr/bin/env node
// Devnet dry run for permutation-frontier (DRAFT, 2026-11-18): builds (with
// --build), checks the .so, computes the devnet cost and prints the plan.
// Sends nothing unless the gate in plan.mjs is open (r0ze's approval flag,
// key file paths, the approved sha256 and filled-in addresses). See
// scripts/devnet/README.md and docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md.
//
// This file only wires the real file system and processes into plan.mjs's run().
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './plan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const io = {
  repoRoot,
  tmpDir: tmpdir(),
  uid: process.getuid?.(),
  readFile: f => readFileSync(f),
  writeFile: (f, t) => writeFileSync(f, t, { flag: 'wx' }),
  mkdir: d => mkdirSync(d, { recursive: true }),
  exists: f => existsSync(f),
  stat: f => statSync(f),
  exec: (cmd, args, { cwd }) => {
    const capture = cmd === 'solana' && (args[0] === 'address' || args[0] === '--version');
    const r = spawnSync(cmd, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  },
  log: t => process.stdout.write(`${t}\n`),
  err: t => process.stderr.write(`${t}\n`),
};
process.exitCode = run(process.argv.slice(2), io);
