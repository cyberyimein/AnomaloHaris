import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Explicit process environment takes precedence over the local repository file. */
export function loadHostEnvironment(repositoryRoot: string): void {
  const path = join(repositoryRoot, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
