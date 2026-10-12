// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatCode, formatPlanFor, unsupportedReason } from '../src/lib/format-code.js';

describe('web format-code', () => {
  it('maps the prettier core set and nothing else', () => {
    expect(formatPlanFor('app.js')?.parser).toBe('babel');
    expect(formatPlanFor('app.ts')?.parser).toBe('typescript');
    expect(formatPlanFor('app.tsx')?.parser).toBe('typescript');
    expect(formatPlanFor('data.json')?.parser).toBe('json');
    expect(formatPlanFor('a.css')?.parser).toBe('css');
    expect(formatPlanFor('a.html')?.parser).toBe('html');
    expect(formatPlanFor('a.xml')?.parser).toBe('html');
    expect(formatPlanFor('a.md')?.parser).toBe('markdown');
    expect(formatPlanFor('a.yaml')?.parser).toBe('yaml');
    expect(formatPlanFor('a.php')).toBeNull();
    expect(formatPlanFor('a.py')).toBeNull();
    expect(formatPlanFor('a.sql')).toBeNull();
    expect(formatPlanFor('run.sh')).toBeNull();
    expect(formatPlanFor('Makefile')).toBeNull();
    expect(unsupportedReason('a.php')).toBe('Prettier has no php parser here');
    expect(unsupportedReason('app.js')).toBeNull();
  });

  it('formats real code with prettier', async () => {
    await expect(formatCode('a.js', 'const x=1')).resolves.toBe('const x = 1;\n');
    await expect(formatCode('a.json', '{"b":2,"a":1}')).resolves.toBe('{ "b": 2, "a": 1 }\n');
    await expect(formatCode('a.md', '# hi\ntext')).resolves.toBe('# hi\n\ntext\n');
    await expect(formatCode('a.css', 'a{color:red}')).resolves.toBe('a {\n  color: red;\n}\n');
  });

  it('rejects syntax errors and unsupported files', async () => {
    await expect(formatCode('a.js', 'const =')).rejects.toThrow();
    await expect(formatCode('a.php', '<?php echo 1;')).rejects.toThrow('Prettier has no php parser here');
  });
});
