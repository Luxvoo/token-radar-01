import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildRadar } from './lib/model.ts';
import type { SnapshotInput } from './lib/model.ts';

const repoRoot = dirname(fileURLToPath(import.meta.url));

function argValue(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1]! : null;
}

function inputPath(): string {
  const given = argValue('--input') ?? '/input/snapshot.json';
  const path = resolve(given);
  return existsSync(path) && statSync(path).isDirectory() ? join(path, 'snapshot.json') : path;
}

function outputPath(): string {
  return resolve(argValue('--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main(): void {
  const input = inputPath();
  const output = outputPath();
  const snapshot = JSON.parse(readFileSync(input, 'utf8')) as SnapshotInput;
  const radar = buildRadar(snapshot);

  mkdirSync(output, { recursive: true });
  rmSync(join(output, 'dashboard'), { recursive: true, force: true });
  rmSync(join(output, 'screenshots'), { recursive: true, force: true });
  cpSync(join(repoRoot, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  cpSync(join(repoRoot, 'screenshots'), join(output, 'screenshots'), { recursive: true });

  writeJson(join(output, 'board.json'), { rows: radar.rows });
  const data = JSON.stringify(radar).replace(/</g, '\\u003c');
  writeFileSync(join(output, 'data.js'), `window.RADAR = ${data};\n`, 'utf8');
  writeFileSync(join(output, 'dossier.json'), buildDossier(output, { text_max_bytes: 65536 }));

  console.log(`Token Radar: ${radar.rows.length} rows, ${radar.live_rows.length} live-token rows, output ${output}`);
}

main();
