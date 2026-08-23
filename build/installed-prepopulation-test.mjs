#!/usr/bin/env node
// Privacy-safe proof that a fresh real-package install retained the exact
// manifest-pinned databases and that their required seeded indexes are usable.
//
// Usage: node installed-prepopulation-test.mjs <package-dir> <installed-data-dir>
//
// This command deliberately prints only PASS or FAIL. Never add row values,
// counts, hashes, paths, or caught error text: its output is written to a public
// GitHub Actions log while it inspects Bill's private package.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [, , requestedPackage, requestedData] = process.argv;

try {
  if (!requestedPackage || !requestedData || process.argv.length !== 4) throw new Error('invalid arguments');

  const packageDir = path.resolve(requestedPackage);
  const dataDir = path.resolve(requestedData);
  const packageState = path.join(packageDir, 'state-template', 'coach.sqlite');
  const packageLibrary = path.join(packageDir, 'library', 'library.sqlite');
  const installedState = path.join(dataDir, 'state', 'coach.sqlite');
  const installedLibrary = path.join(dataDir, 'library', 'library.sqlite');

  // This comparison happens before either installed database is opened. The
  // manifest gate has already pinned both package files, so equality here proves
  // the exact seeded bytes—not merely a similar row count—reached the profile.
  requireSameBytes(packageState, installedState);
  requireSameBytes(packageLibrary, installedLibrary);

  const state = new DatabaseSync(installedState, { readOnly: true });
  try {
    for (const table of [
      'principal_profile',
      'roles',
      'facts',
      'memories',
      'investor_roster',
      'green_flags',
    ]) {
      requireRows(state, table);
    }
    requireMatch(state, 'state_fts', 'role');
  } finally {
    state.close();
  }

  const library = new DatabaseSync(installedLibrary, { readOnly: true });
  try {
    for (const table of ['documents', 'chunks', 'doctrine', 'market_deals']) {
      requireRows(library, table);
    }
    requireMatch(library, 'chunks_fts', 'founder');
  } finally {
    library.close();
  }

  console.log('PASS installed private prepopulation');
} catch {
  console.error('FAIL installed private prepopulation');
  process.exitCode = 1;
}

function requireSameBytes(left, right) {
  const leftBytes = fs.readFileSync(left);
  const rightBytes = fs.readFileSync(right);
  if (leftBytes.length !== rightBytes.length
      || sha256(leftBytes) !== sha256(rightBytes)) {
    throw new Error('installed database differs');
  }
}

function requireRows(db, table) {
  // Table names are fixed source constants, never caller input.
  const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS ok`).get();
  if (row?.ok !== 1) throw new Error('required seed table is empty');
}

function requireMatch(db, table, query) {
  const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${table} MATCH ? LIMIT 1) AS ok`).get(query);
  if (row?.ok !== 1) throw new Error('required full-text index is unusable');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
