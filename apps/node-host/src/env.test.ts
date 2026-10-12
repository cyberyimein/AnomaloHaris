import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadHostEnvironment } from './env.js';

describe('Host environment', () => {
  it('loads the repository dotenv without overriding an explicit environment value', () => {
    const root = mkdtempSync(join(tmpdir(), 'anomaloharis-env-'));
    const fresh = `ANOMALOHARIS_TEST_${randomUUID().replaceAll('-', '_')}`;
    const override = `${fresh}_EXPLICIT`;
    process.env[override] = 'external-value';
    writeFileSync(join(root, '.env'), `${fresh}=dotenv-value\n${override}=file-value\n`);
    try {
      loadHostEnvironment(root);
      expect(process.env[fresh]).toBe('dotenv-value');
      expect(process.env[override]).toBe('external-value');
    } finally { delete process.env[fresh]; delete process.env[override]; }
  });
  it('allows a Host with no dotenv file to start from injected configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'anomaloharis-no-env-'));
    expect(() => loadHostEnvironment(root)).not.toThrow();
  });
});
