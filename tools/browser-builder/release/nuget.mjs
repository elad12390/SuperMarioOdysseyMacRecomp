import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLogged } from './processes.mjs';
import { randomUUID } from 'node:crypto';

export async function verifyNugetPackages(packages, scratch) {
  const work = path.join(scratch, 'nuget-verification', randomUUID());
  await mkdir(work, { recursive: true });
  const project = fileURLToPath(new URL('./nuget-verifier/NugetVerifier.csproj', import.meta.url));
  await runLogged(['dotnet', 'build', project, '-c', 'Release', '--artifacts-path', path.join(work, 'artifacts')], { directory: work, label: 'build', cwd: path.dirname(project) });
  const input = path.join(work, 'packages.json'), output = path.join(work, 'verified.json');
  await writeFile(input, JSON.stringify(packages));
  await runLogged(['dotnet', path.join(work, 'artifacts/bin/NugetVerifier/release/NugetVerifier.dll'), input, output], { directory: work, label: 'verify', cwd: work });
  const result = JSON.parse(await readFile(output, 'utf8'));
  if (result.length !== packages.length) throw new Error('NuGet verification did not cover every package');
  return new Map(result.map(row => [row.id, row]));
}
