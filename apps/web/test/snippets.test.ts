// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SNIPPETS,
  MAX_CUSTOM,
  SNIPPET_KEY,
  cleanSnippets,
  isDestructive,
  loadSnippets,
  saveSnippets,
} from '../src/lib/snippets.js';
import type { SnippetStorage } from '../src/lib/snippets.js';

function memStorage(seed?: string): SnippetStorage & { dump(): string | null } {
  let value: string | null = seed ?? null;
  return {
    dump: () => value,
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
}

describe('web snippets lib', () => {
  it('ships six rebranded presets', () => {
    expect(DEFAULT_SNIPPETS).toEqual([
      'pkg update',
      'pkg upgrade',
      'pm2 restart olp',
      'termux-wake-lock',
      'htop',
      'git status',
    ]);
  });

  it('round-trips valid snippets', () => {
    const store = memStorage();
    saveSnippets(['htop', 'git log --oneline'], store);
    expect(loadSnippets(store)).toEqual(['htop', 'git log --oneline']);
    expect(JSON.parse(store.dump() ?? 'null')).toEqual(['htop', 'git log --oneline']);
  });

  it('cleans corrupt, long, empty, duplicate, and over-count input', () => {
    expect(loadSnippets(memStorage('not json{{{'))).toEqual([]);
    expect(loadSnippets(memStorage('{"a":1}'))).toEqual([]);
    expect(loadSnippets(memStorage('null'))).toEqual([]);
    expect(cleanSnippets(['ok', '', '  ', 'ok', 42, `x`.repeat(501)])).toEqual(['ok']);
    const many = Array.from({ length: MAX_CUSTOM + 5 }, (_, i) => `cmd${i}`);
    expect(cleanSnippets(many)).toHaveLength(MAX_CUSTOM);
  });

  it('matches destructive patterns and spares safe ones', () => {
    for (const cmd of [
      'killall node',
      'kill -9 123',
      'pm2 restart olp',
      'pm2 kill',
      'sudo reboot',
      'halt',
      'shutdown -h now',
      'rm -rf /tmp/x',
      'rm -fr x',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'echo hi | dd of=x',
    ]) {
      expect(isDestructive(cmd)).toBe(true);
    }
    for (const cmd of ['htop', 'git status', 'pkg update', 'echo hi', 'ls -la', 'termux-wake-lock']) {
      expect(isDestructive(cmd)).toBe(false);
    }
  });

  it('never throws without storage', () => {
    localStorage.clear();
    expect(loadSnippets(undefined)).toEqual([]);
    expect(() => saveSnippets(['x'], undefined)).not.toThrow();
    localStorage.clear();
  });

  it('uses the namespaced key', () => {
    expect(SNIPPET_KEY).toBe('olp.snippets.v1');
  });
});
