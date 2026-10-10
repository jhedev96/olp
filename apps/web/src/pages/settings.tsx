import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** Settings page inputs (tests inject navigation + timers). */
export interface SettingsPageDeps {
  goto?: (url: string) => void;
  later?: (fn: () => void, ms: number) => void;
}

/**
 * Settings (Terwo settings-tab parity): username display + version,
 * change-username, change-password (client confirm check, field clear,
 * delayed login redirect), telegram form + save + test button,
 * confirm-gated logout-all.
 */
export function SettingsPage(deps: SettingsPageDeps = {}): ReactElement {
  const goto =
    deps.goto ??
    ((url: string): void => {
      window.location.href = url;
    });
  const later =
    deps.later ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms);
    });
  const [username, setUsername] = useState('');
  const [version, setVersion] = useState('');
  const [newUser, setNewUser] = useState('');
  const [userError, setUserError] = useState('');
  const [pw, setPw] = useState({ old: '', next: '', confirm: '' });
  const [pwMessage, setPwMessage] = useState('');
  const [tg, setTg] = useState({ botToken: '', chatId: '', enabled: false, commandsEnabled: true });
  const [tgMessage, setTgMessage] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{
        username: string;
        version: string;
        telegram: { botToken: string; chatId: string; enabled: boolean; commandsEnabled: boolean };
      }>('/api/settings');
      setUsername(body.username);
      setVersion(body.version);
      const telegram = body.telegram;
      setTg({
        botToken: telegram.botToken,
        chatId: telegram.chatId,
        enabled: telegram.enabled,
        commandsEnabled: telegram.commandsEnabled,
      });
    } catch {
      // keep the previous render (Terwo parity)
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveUsername = async (): Promise<void> => {
    setUserError('');
    try {
      const body = await apiJson<{ ok?: unknown; username?: unknown; error?: string }>('/api/auth/change-username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUser.trim() }),
      });
      if (body.ok === true) {
        setNewUser('');
        await load();
      } else setUserError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setUserError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const savePassword = async (): Promise<void> => {
    if (pw.next !== pw.confirm) {
      setPwMessage('Password confirmation does not match');
      return;
    }
    setPwMessage('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: pw.old, newPassword: pw.next, confirmPassword: pw.confirm }),
      });
      if (body.ok === true) {
        setPw({ old: '', next: '', confirm: '' });
        setPwMessage('Password changed — please log in again');
        later(() => goto('/login'), 1200);
      } else setPwMessage(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setPwMessage(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const saveTelegram = async (): Promise<void> => {
    setTgMessage('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram: tg }),
      });
      if (body.ok !== true) setTgMessage(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setTgMessage(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const testTelegram = async (): Promise<void> => {
    setTgMessage('sending…');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/settings/test-telegram', { method: 'POST' });
      setTgMessage(body.ok === true ? 'Test message sent' : typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setTgMessage(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const logoutAll = async (): Promise<void> => {
    if (!window.confirm('Log out all sessions? End all active sessions on every device. You will need to log in again.')) {
      return;
    }
    await apiJson('/api/auth/logout-all', { method: 'POST' }).catch(() => undefined);
    goto('/login');
  };

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Settings</h1>
      <p className="mb-4 text-sm text-neutral-400">
        Logged in as <span className="font-medium text-neutral-200">{username}</span>
        {version !== '' && <span> · v{version}</span>}
      </p>

      <Card className="mb-3">
        <h2 className="mb-2 font-bold">Username</h2>
        {userError !== '' && (
          <p role="alert" className="mb-2 text-sm text-red-400">
            {userError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Input placeholder="New username" value={newUser} onChange={(ev) => setNewUser(ev.target.value)} className="w-52" />
          <Button size="sm" onClick={() => void saveUsername()}>
            Save username
          </Button>
        </div>
      </Card>

      <Card className="mb-3">
        <h2 className="mb-2 font-bold">Password</h2>
        {pwMessage !== '' && <p className="mb-2 text-sm text-neutral-300">{pwMessage}</p>}
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Current password" type="password" value={pw.old} onChange={(ev) => setPw({ ...pw, old: ev.target.value })} className="w-52" />
          <Input placeholder="New password" type="password" value={pw.next} onChange={(ev) => setPw({ ...pw, next: ev.target.value })} className="w-52" />
          <Input
            placeholder="Confirm new password"
            type="password"
            value={pw.confirm}
            onChange={(ev) => setPw({ ...pw, confirm: ev.target.value })}
            className="w-52"
          />
          <Button size="sm" onClick={() => void savePassword()}>
            Save password
          </Button>
        </div>
      </Card>

      <Card className="mb-3">
        <h2 className="mb-2 font-bold">Telegram</h2>
        {tgMessage !== '' && <p className="mb-2 text-sm text-neutral-300">{tgMessage}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Bot token" value={tg.botToken} onChange={(ev) => setTg({ ...tg, botToken: ev.target.value })} className="w-64" />
          <Input placeholder="Chat ID" value={tg.chatId} onChange={(ev) => setTg({ ...tg, chatId: ev.target.value })} className="w-40" />
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={tg.enabled} onChange={(ev) => setTg({ ...tg, enabled: ev.target.checked })} />
            Enabled
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={tg.commandsEnabled}
              onChange={(ev) => setTg({ ...tg, commandsEnabled: ev.target.checked })}
            />
            Reply to commands
          </label>
          <Button size="sm" onClick={() => void saveTelegram()}>
            Save telegram
          </Button>
          <Button size="sm" variant="outline" onClick={() => void testTelegram()}>
            Send test
          </Button>
        </div>
      </Card>

      <Button size="sm" variant="outline" onClick={() => void logoutAll()}>
        Log out all sessions
      </Button>
    </main>
  );
}
