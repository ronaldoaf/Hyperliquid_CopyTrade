import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Respostas brutas das APIs, um arquivo .jsonl.gz por dia. Cada coleta acrescenta um membro gzip,
// e arquivos com vários membros são lidos normalmente por zcat, gzip.open (Python) e zlib.gunzipSync.
export function appendRaw(dir, ts, records) {
  if (!records.length) return;
  mkdirSync(dir, { recursive: true });
  const day = new Date(ts).toISOString().slice(0, 10);
  const lines = records.map((r) => JSON.stringify({ ts, ...r })).join('\n') + '\n';
  appendFileSync(join(dir, `${day}.jsonl.gz`), gzipSync(lines));
}

// Cópia diária do banco, mantendo as últimas `keep`.
export function dailyBackup(db, dir, keep = 3) {
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(dir, `dashboard-${day}.db`);
  const existing = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  if (existing.includes(`dashboard-${day}.db`)) return;
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  for (const old of [...existing, `dashboard-${day}.db`].sort().slice(0, -keep)) rmSync(join(dir, old));
  console.log(`[backup] ${file}`);
}
