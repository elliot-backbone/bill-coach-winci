#!/usr/bin/env node
// Bill Jennings Coach — deterministic manifest/file integrity gate.
// Usage: node build/manifest-integrity-test.mjs <package-dir>

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const requestedRoot = process.argv[2];
if (!requestedRoot || process.argv.length !== 3) {
  console.error('Usage: node manifest-integrity-test.mjs <package-dir>');
  process.exitCode = 2;
} else {
  verify(path.resolve(requestedRoot));
}

function verify(root) {
  const failures = [];
  const manifestPath = path.join(root, 'manifest.json');

  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (err) {
    fail(`package directory cannot be read: ${root} (${err.message})`);
    return report();
  }
  if (!rootStat.isDirectory()) {
    fail(`package path is not a directory: ${root}`);
    return report();
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`manifest.json cannot be parsed: ${err.message}`);
    return report();
  }

  if (!Array.isArray(manifest?.files)) {
    fail('manifest.files must be an array');
    return report();
  }

  const declared = new Map();
  const declaredWindowsPaths = new Map();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const label = `manifest.files[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${label} must be an object`);
      continue;
    }

    const rel = entry.path;
    if (!isSafeManifestPath(rel)) {
      fail(`${label}.path is not a safe Windows-compatible relative POSIX path: ${String(rel)}`);
      continue;
    }
    if (declared.has(rel)) {
      fail(`duplicate manifest path: ${rel}`);
      continue;
    }
    const windowsPath = windowsPathKey(rel);
    if (declaredWindowsPaths.has(windowsPath)) {
      fail(`case-insensitive duplicate manifest path: ${rel} conflicts with ${declaredWindowsPaths.get(windowsPath)}`);
      continue;
    }

    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail(`invalid sha256 for ${rel}: expected 64 lowercase hexadecimal characters`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail(`invalid size for ${rel}: expected a non-negative safe integer`);
    }
    declared.set(rel, entry);
    declaredWindowsPaths.set(windowsPath, rel);
  }

  const present = new Map();
  walkPackage(root, '', present, failures);

  for (const [rel, abs] of present) {
    const entry = declared.get(rel);
    if (!entry) {
      fail(`unlisted package file: ${rel}`);
      continue;
    }

    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (err) {
      fail(`cannot read package file ${rel}: ${err.message}`);
      continue;
    }

    const actualSize = bytes.length;
    if (Number.isSafeInteger(entry.size) && entry.size >= 0 && actualSize !== entry.size) {
      fail(`size mismatch for ${rel}: manifest ${entry.size}, actual ${actualSize}`);
    }

    if (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) {
      const actualHash = sha256(bytes);
      if (actualHash !== entry.sha256) {
        fail(`hash mismatch for ${rel}: manifest ${entry.sha256}, actual ${actualHash}`);
      }
    }
  }

  for (const rel of declared.keys()) {
    if (!present.has(rel)) fail(`manifest path missing from package: ${rel}`);
  }

  report(present.size, declared.size);

  function fail(message) {
    failures.push(message);
  }

  function report(presentCount = 0, declaredCount = 0) {
    if (failures.length === 0) {
      console.log(`PASS manifest integrity: ${presentCount} package files match ${declaredCount} manifest entries (${root})`);
      return;
    }
    console.error(`FAIL manifest integrity: ${failures.length} issue${failures.length === 1 ? '' : 's'} (${root})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

function isSafeManifestPath(rel) {
  if (typeof rel !== 'string'
      || rel.length === 0
      || rel.includes('\\')
      || path.posix.isAbsolute(rel)
      || path.win32.isAbsolute(rel)) {
    return false;
  }

  return rel.split('/').every(isSafeWindowsPathComponent);
}

function isSafeWindowsPathComponent(part) {
  if (part === '' || part === '.' || part === '..') return false;
  if (/[<>:"|?*\u0000-\u001f]/u.test(part)) return false;
  if (/[. ]$/u.test(part)) return false;

  // Windows device names remain reserved when used as directory names or
  // followed by an extension (for example CON.txt and LPT1.log).
  const basename = part.split('.', 1)[0];
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(basename);
}

function windowsPathKey(rel) {
  // A package must be extractable on Windows, whose ordinary filesystems are
  // case-insensitive. NFC also makes the comparison deterministic when the
  // verifier runs on a filesystem that stores decomposed Unicode filenames.
  return rel.normalize('NFC').toUpperCase();
}

function isExcluded(rel, name) {
  if (name === '.DS_Store') return true;
  if (rel === 'manifest.json') return true;
  return /^state-template\/[^/]+\.sqlite-(?:wal|shm|journal)$/.test(rel);
}

function walkPackage(root, relDir, present, failures) {
  const absDir = relDir ? path.join(root, ...relDir.split('/')) : root;
  let names;
  try {
    names = fs.readdirSync(absDir).sort();
  } catch (err) {
    failures.push(`cannot read package directory ${relDir || '.'}: ${err.message}`);
    return;
  }

  for (const name of names) {
    const rel = relDir ? `${relDir}/${name}` : name;
    if (isExcluded(rel, name)) continue;

    const abs = path.join(absDir, name);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      failures.push(`cannot inspect package path ${rel}: ${err.message}`);
      continue;
    }

    if (stat.isSymbolicLink()) {
      failures.push(`package path is a symbolic link, not a regular file: ${rel}`);
    } else if (stat.isDirectory()) {
      walkPackage(root, rel, present, failures);
    } else if (stat.isFile()) {
      present.set(rel, abs);
    } else {
      failures.push(`package path is not a regular file or directory: ${rel}`);
    }
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
