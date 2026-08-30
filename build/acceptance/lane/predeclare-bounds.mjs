// Writes the edition's census bounds and their sha256 BEFORE any capture runs (T-QUAL-002 bounds-predeclared.json).
import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { DEFAULT_BOUNDS } from './quality-census.mjs';
const out = process.argv[2]; if (!out) { console.error('usage: predeclare-bounds.mjs <out.json>'); process.exit(2); }
const body = JSON.stringify(DEFAULT_BOUNDS, null, 2);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ schema: 'bill-coach.bounds-predeclared/v1', declaredAt: new Date().toISOString(), boundsSha256: crypto.createHash('sha256').update(body).digest('hex'), bounds: DEFAULT_BOUNDS }, null, 2)}\n`);
console.log(`bounds predeclared: ${Object.keys(DEFAULT_BOUNDS).length}`);
