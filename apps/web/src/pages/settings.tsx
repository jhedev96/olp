import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtAgo, fmtDate, fmtIn } from '../lib/format.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { Badge } from '../components/common/Badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** Password strength (client-side length + class check, no backend). */
export function passwordStrength(pw: string): 'Weak' | 'Medium' | 'Strong' {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^a-zA-Z0-9]/.test(pw)) classes++;
  if (pw.length >= 16 && classes >= 3) return 'Strong';
  if (pw.length >= 10 && classes >= 2) return 'Medium';
  return 'Weak';
}

/** Daemon reload command (rebranded pm2 process name, static docs). */
export const RELOAD_CMD = 'pm2 restart olp';

/** `/api/auth/sessions` row shape (server contract). */
export interface SessionRow {
  id: string;
  browser: string;
  os: string;
  ip: string;
  created: number;
  lastSeen: number;
  expiresAt: number;
  current: boolean;
}

/** `/api/auth/passkeys` row shape (server contract). */
export interface PasskeyRow {
  id: string;
  name: string;
  created: number;
}

/** `/api/settings` bind shape (server contract). */
export interface BindState {
  host: string;
  port: number;
  loopback: boolean;
}

/** Settings page inputs (tests inject navigation + timers). */
export interface SettingsPageDeps {
  goto?: (url: string) => void;
  later?: (fn: () => void, ms: number) => void;
}

/**
 * Settings (mockup settings parity): username display + version,
 * change-username, change-password (client confirm check, field clear,
 * delayed login redirect), telegram form + save + test button,
 * config export/copy, dialog-gated logout-all. Saved actions toast.
 * Server config is real (wave 9, CAND-031 core): telegram verified
 * badge (stored-token proxy), read-only bind card with loopback
 * badge, per-row session expiry. The mockup's PBKDF2 310k text and
 * rehash-on-boot flag are dropped — the flag has no cryptographic
 * effect and 310k contradicts the real 120k in `packages/auth`
 * (spec-server-config-wave §10). Editable bind → CAND-037.
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
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [pendingRevoke, setPendingRevoke] = useState<SessionRow | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [botName, setBotName] = useState<string | null | undefined>(undefined);
  const [bind, setBind] = useState<BindState | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [keyName, setKeyName] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [pendingDeleteKey, setPendingDeleteKey] = useState<PasskeyRow | null>(null);
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState(false);
  const [reloadCopied, setReloadCopied] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{
        username: string;
        version: string;
        bind?: BindState;
        telegram: { botToken: string; chatId: string; enabled: boolean; commandsEnabled: boolean };
      }>('/api/settings');
      setUsername(body.username);
      setVersion(body.version);
      if (body.bind !== undefined && typeof body.bind === 'object' && body.bind !== null) setBind(body.bind);
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

  const loadIdentity = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ username: string | null }>('/api/settings/telegram/identity');
      setBotName(typeof body.username === 'string' ? body.username : null);
    } catch {
      setBotName(null);
    }
  }, []);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  const loadKeys = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ passkeys: PasskeyRow[] }>('/api/auth/passkeys');
      if (Array.isArray(body.passkeys)) setPasskeys(body.passkeys);
    } catch {
      // passkeys card keeps the previous render
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const registerKey = async (): Promise<void> => {
    setKeyMessage('');
    const creds = (
      window.navigator as unknown as {
        credentials?: { create(o: unknown): Promise<unknown> };
      }
    ).credentials;
    if (creds === undefined) {
      setKeyMessage('Passkeys are not supported in this browser');
      return;
    }
    try {
      const opts = await apiJson<{ options?: unknown; state?: unknown }>('/api/auth/passkey/register/options', {
        method: 'POST',
      });
      if (typeof opts.state !== 'string') throw new Error('Bad ceremony state');
      const attestation = await creds.create({ publicKey: opts.options });
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: opts.state, name: keyName.trim(), response: attestation }),
      });
      if (body.ok === true) {
        setKeyName('');
        await loadKeys();
      } else setKeyMessage(typeof body.error === 'string' ? body.error : 'Registration failed');
    } catch (err) {
      setKeyMessage(err instanceof ApiError || err instanceof Error ? err.message : 'Registration failed');
    }
  };

  const confirmDeleteKeyAction = async (): Promise<void> => {
    if (pendingDeleteKey === null) return;
    const target = pendingDeleteKey;
    setPendingDeleteKey(null);
    await apiJson(`/api/auth/passkeys/${target.id}`, { method: 'DELETE' }).catch(() => undefined);
    await loadKeys();
  };

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ sessions: SessionRow[] }>('/api/auth/sessions');
      if (Array.isArray(body.sessions)) setSessions(body.sessions);
    } catch {
      // sessions card keeps the previous render
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const confirmRevokeAction = async (): Promise<void> => {
    if (pendingRevoke === null) return;
    const target = pendingRevoke;
    setPendingRevoke(null);
    try {
      const body = await apiJson<{ ok?: unknown; self?: unknown }>(`/api/auth/sessions/${target.id}/revoke`, {
        method: 'POST',
      });
      // No Revoke button on the current row, but a crafted id could
      // still hit self: land on login instead of a dead table.
      if (body.self === true) {
        goto('/login');
        return;
      }
    } catch {
      // the table keeps its rows on failure (Terwo parity)
    }
    await loadSessions();
  };

  const confirmOthersAction = async (): Promise<void> => {
    setConfirmOthers(false);
    await apiJson('/api/auth/sessions/others/revoke', { method: 'POST' }).catch(() => undefined);
    await loadSessions();
  };

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
        setToast('Username saved');
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
      if (body.ok === true) setToast('Telegram saved');
      else setTgMessage(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setTgMessage(err instanceof ApiError ? err.message : 'Failed');
    }
    // Token may have changed: re-verify the badge.
    setBotName(undefined);
    await loadIdentity();
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

  /** Serialize the loaded panel config (client-side only, no endpoint). */
  const configJson = (): string =>
    JSON.stringify({ username, version, telegram: tg }, null, 2);

  const exportConfig = (): void => {
    if (typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([configJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'olp-config.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyConfig = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(configJson());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked: export still works
    }
  };

  const copyReload = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(RELOAD_CMD);
      setReloadCopied(true);
      setTimeout(() => setReloadCopied(false), 1600);
    } catch {
      // clipboard blocked: the command stays visible for manual copy
    }
  };

  const logoutAll = (): void => {
    setConfirmLogoutAll(true);
  };

  const confirmLogoutAllAction = async (): Promise<void> => {
    setConfirmLogoutAll(false);
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
      {toast !== '' && (
        <p role="status" className="mb-3 text-sm text-emerald-400">
          {toast}
        </p>
      )}

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
        {pw.next !== '' && (
          <p className="mt-2 text-xs text-neutral-400">
            Strength: <span className="font-semibold text-neutral-200">{passwordStrength(pw.next)}</span>
          </p>
        )}
      </Card>

      <Card className="mb-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto font-bold">Telegram</h2>
          {botName === undefined ? (
            <span className="text-xs text-neutral-500">Checking bot…</span>
          ) : botName === null ? (
            <Badge tone="neutral">Unverified</Badge>
          ) : (
            <Badge tone="success">Verified: @{botName}</Badge>
          )}
        </div>
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
      <div className="mt-3 flex flex-col gap-3">
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-bold">Configuration</h2>
            <Button size="sm" variant="outline" onClick={exportConfig}>
              Export JSON
            </Button>
            <Button size="sm" variant="outline" onClick={() => void copyConfig()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="mt-1 text-xs text-neutral-500">Snapshots the loaded panel config, bot token included — store it safely.</p>
        </Card>
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-bold">Active device sessions</h2>
            <Badge tone="info">
              {sessions.length} connected
            </Badge>
            {sessions.some((s) => !s.current) && (
              <Button size="sm" variant="outline" onClick={() => setConfirmOthers(true)}>
                Log out other sessions
              </Button>
            )}
          </div>
          {sessions.length === 0 ? (
            <p className="text-sm text-neutral-400">No active sessions.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((session) => (
                <li key={session.id} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 px-2 py-1.5 text-sm">
                  <span className="mr-auto min-w-0">
                    <span className="font-medium">{session.browser}</span>
                    <span className="block font-mono text-xs text-neutral-400">
                      {session.ip} • {session.os} • {fmtAgo(session.lastSeen)} • Expires {fmtIn(session.expiresAt)}
                    </span>
                  </span>
                  <span className="text-xs text-green-400">Active</span>
                  {session.current ? (
                    <Badge tone="success">THIS DEVICE</Badge>
                  ) : (
                    <Button size="sm" variant="destructive" onClick={() => setPendingRevoke(session)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-bold">Passkeys</h2>
            <Badge tone="info">
              {passkeys.length} registered
            </Badge>
          </div>
          {keyMessage !== '' && (
            <p role="alert" className="mb-2 text-sm text-red-400">
              {keyMessage}
            </p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Input
              placeholder="Key name (e.g. YubiKey 5)"
              aria-label="New passkey name"
              value={keyName}
              onChange={(ev) => setKeyName(ev.target.value)}
              className="w-52"
            />
            <Button size="sm" onClick={() => void registerKey()}>
              Register passkey
            </Button>
          </div>
          {passkeys.length === 0 ? (
            <p className="text-sm text-neutral-400">No passkeys yet — password sign-in always works.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {passkeys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 px-2 py-1.5 text-sm">
                  <span className="mr-auto font-medium">{key.name === '' ? key.id.slice(0, 12) : key.name}</span>
                  <span className="font-mono text-xs text-neutral-400">{fmtDate(key.created)}</span>
                  <Button size="sm" variant="destructive" onClick={() => setPendingDeleteKey(key)}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-bold">Bind address</h2>
            {bind !== null &&
              (bind.loopback ? (
                <Badge tone="success">Loopback only</Badge>
              ) : (
                <Badge tone="danger">LAN exposed — do not put on the internet</Badge>
              ))}
          </div>
          {bind === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <p className="font-mono text-sm text-neutral-300">
              {bind.host}:{bind.port}
            </p>
          )}
          <p className="mt-1 text-xs text-neutral-500">
            Read-only (editing needs a restart-capable config — CAND-037). Apply out-of-band edits via the daemon reload below.
          </p>
        </Card>
        <Card>
          <h2 className="font-bold">Daemon reload</h2>
          <p className="mt-1 text-xs text-neutral-500">Apply out-of-band config edits by restarting the service:</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono text-xs">{RELOAD_CMD}</code>
            <Button size="sm" variant="outline" onClick={() => void copyReload()}>
              {reloadCopied ? 'Copied' : 'Copy command'}
            </Button>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={confirmLogoutAll}
        title="Log out all sessions"
        message="Log out all sessions? End all active sessions on every device. You will need to log in again."
        confirmLabel="Log out all"
        destructive={true}
        onConfirm={() => void confirmLogoutAllAction()}
        onCancel={() => setConfirmLogoutAll(false)}
      />
      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke session"
        message={`Revoke the session from ${pendingRevoke?.browser ?? ''} (${pendingRevoke?.ip ?? ''})? That device will need to log in again.`}
        confirmLabel="Revoke"
        destructive={true}
        onConfirm={() => void confirmRevokeAction()}
        onCancel={() => setPendingRevoke(null)}
      />
      <ConfirmDialog
        open={confirmOthers}
        title="Log out other sessions"
        message="Log out all sessions except this device? Other devices will need to log in again."
        confirmLabel="Log out others"
        destructive={true}
        onConfirm={() => void confirmOthersAction()}
        onCancel={() => setConfirmOthers(false)}
      />
      <ConfirmDialog
        open={pendingDeleteKey !== null}
        title="Delete passkey"
        message={`Delete the passkey "${pendingDeleteKey?.name === '' ? (pendingDeleteKey?.id.slice(0, 12) ?? '') : (pendingDeleteKey?.name ?? '')}"? Password sign-in keeps working.`}
        confirmLabel="Delete"
        destructive={true}
        onConfirm={() => void confirmDeleteKeyAction()}
        onCancel={() => setPendingDeleteKey(null)}
      />
    </main>
  );
}
