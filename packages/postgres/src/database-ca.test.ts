import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseCaFile } from './database-ca.js';

const ALIAS_LINE = 'CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH';
const REQUIRED_LINE = 'CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE';

// Next.js's global types make NODE_ENV a required ProcessEnv key; the helper ignores it.
const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars });

function resolve(vars: Record<string, string>) {
  const lines: string[] = [];
  return { value: resolveDatabaseCaFile(env(vars), line => lines.push(line)), lines };
}

describe('resolveDatabaseCaFile', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the canonical UNAI_DATABASE_CA_FILE and reports nothing', () => {
    expect(resolve({ UNAI_DATABASE_CA_FILE: '/etc/unai/ca.pem' })).toEqual({ value: '/etc/unai/ca.pem', lines: [] });
  });

  it('accepts the deprecated UNAI_DATABASE_CA_PATH alias with exactly one deprecation line', () => {
    expect(resolve({ UNAI_DATABASE_CA_PATH: '/tmp/ca.pem' })).toEqual({ value: '/tmp/ca.pem', lines: [ALIAS_LINE] });
  });

  it('reports the alias once when both names carry the same value', () => {
    expect(resolve({ UNAI_DATABASE_CA_FILE: '/same.pem', UNAI_DATABASE_CA_PATH: '/same.pem' }))
      .toEqual({ value: '/same.pem', lines: [ALIAS_LINE] });
  });

  it('refuses different values with a bare conflict code before reporting anything', () => {
    const lines: string[] = [];
    let message = '';
    expect(() => {
      try {
        resolveDatabaseCaFile(env({ UNAI_DATABASE_CA_FILE: '/a/file.pem', UNAI_DATABASE_CA_PATH: '/b/path.pem' }), line => lines.push(line));
      } catch (error) {
        message = (error as Error).message;
        throw error;
      }
    }).toThrow(/^CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE$/);
    expect(message).toBe('CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE');
    expect(message).not.toContain('/a/file.pem');
    expect(message).not.toContain('/b/path.pem');
    expect(lines).toEqual([]);
  });

  it('names the canonical variable and returns undefined when neither is set', () => {
    expect(resolve({})).toEqual({ value: undefined, lines: [REQUIRED_LINE] });
    expect(resolve({ UNAI_DATABASE_CA_FILE: '', UNAI_DATABASE_CA_PATH: '' })).toEqual({ value: undefined, lines: [REQUIRED_LINE] });
  });

  it('treats an empty canonical value as unset when the alias is set', () => {
    expect(resolve({ UNAI_DATABASE_CA_FILE: '', UNAI_DATABASE_CA_PATH: '/tmp/ca.pem' }))
      .toEqual({ value: '/tmp/ca.pem', lines: [ALIAS_LINE] });
  });

  it('writes to stderr through console.error by default, once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveDatabaseCaFile(env({ UNAI_DATABASE_CA_PATH: '/tmp/ca.pem' }))).toBe('/tmp/ca.pem');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ALIAS_LINE);
  });
});
