import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function runLogged(args, { directory, label, cwd, env = process.env }) {
  await mkdir(directory, { recursive: true });
  const log = path.join(directory, label + '.log');
  const file = await open(log, 'w');
  const process = spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ['ignore', file.fd, file.fd] });
  const completion = new Promise((resolve, reject) => { process.once('error', reject); process.once('exit', code => resolve(code ?? 1)); });
  await writeFile(path.join(directory, label + '.pid'), String(process.pid) + '\n');
  await file.close();
  const code = await completion;
  await writeFile(path.join(directory, label + '.status'), String(code) + '\n');
  if (code) throw new Error(`${label} failed with exit ${code}; inspect ${log}`);
  return { pid: process.pid, exitCode: code, log };
}
