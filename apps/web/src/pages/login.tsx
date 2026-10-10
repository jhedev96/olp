import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { getTheme, setTheme } from '../lib/theme.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/**
 * Login card (Terwo `login.html` parity): username/password form, theme
 * toggle, inline error line, Enter submits. Success performs a full
 * reload to `/dashboard` so the app boots authed (the session cookie is
 * `HttpOnly`, JS never holds it).
 */
export function LoginPage({ goto }: { goto?: (url: string) => void } = {}): ReactElement {
  const go = goto ?? ((url: string): void => {
    window.location.href = url;
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [theme, setThemeState] = useState(getTheme);

  const toggleTheme = (): void => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  const submit = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown }>(
        '/api/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        },
        { unauthorized: 'rethrow' },
      );
      if (body.ok === true) go('/dashboard');
      else setError('Login failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <Button variant="ghost" size="icon" className="absolute right-4 top-4" title={theme === 'light' ? 'Dark mode' : 'Light mode'} onClick={toggleTheme}>
        {theme === 'light' ? '🌙' : '☀️'}
      </Button>
      <Card className="w-full max-w-[340px]">
        <CardTitle className="text-center">OpenLocalPanel</CardTitle>
        <p className="mb-5 mt-1 text-center text-xs text-neutral-400">Local operations panel</p>
        <CardContent>
          <form onSubmit={(ev) => void submit(ev)} className="flex flex-col gap-3">
            <Input placeholder="Username" autoComplete="username" value={username} onChange={(ev) => setUsername(ev.target.value)} />
            <Input
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
            />
            <Button type="submit" className="w-full" disabled={busy}>
              Log in
            </Button>
          </form>
          {error !== '' && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
