import { ApiError, apiJson } from '../lib/api.js';
import { getTheme, setTheme } from '../lib/theme.js';

/** Page lifecycle (mounted by `main.ts` per slug, unmounted on leave). */
export interface Page {
  mount(root: HTMLElement): void;
  unmount(): void;
}

/** Login page inputs (tests inject `goto`; production reloads). */
export interface LoginPageDeps {
  goto?: (url: string) => void;
}

/**
 * Login card (Terwo `login.html` parity): username/password form, theme
 * toggle, inline error line, Enter submits. Success performs a full
 * reload to `/dashboard` so the app boots authed (Terwo parity — the
 * session cookie is `HttpOnly`, JS never holds it).
 */
export function LoginPage(deps: LoginPageDeps = {}): Page {
  const goto = deps.goto ?? ((url: string): void => {
    window.location.href = url;
  });
  const aborter = new AbortController();
  let root: HTMLElement | null = null;

  const onTheme = (): void => {
    setTheme(getTheme() === 'light' ? 'dark' : 'light');
    paintTheme();
  };

  const paintTheme = (): void => {
    const button = root?.querySelector<HTMLButtonElement>('[data-action="theme"]');
    if (button === null || button === undefined) return;
    const light = getTheme() === 'light';
    button.textContent = light ? '🌙' : '☀️';
    button.title = light ? 'Dark mode' : 'Light mode';
  };

  const fail = (message: string): void => {
    const err = root?.querySelector<HTMLElement>('[data-error]');
    if (err !== null && err !== undefined) err.textContent = message;
  };

  const submit = async (): Promise<void> => {
    const user = root?.querySelector<HTMLInputElement>('[data-user]');
    const pass = root?.querySelector<HTMLInputElement>('[data-pass]');
    fail('');
    try {
      const body = await apiJson<{ ok?: unknown }>(
        '/api/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user?.value ?? '', password: pass?.value ?? '' }),
        },
        { unauthorized: 'rethrow' },
      );
      if (body.ok === true) goto('/dashboard');
      else fail('Login failed');
    } catch (err) {
      fail(err instanceof ApiError ? err.message : 'Login failed');
    }
  };

  return {
    mount(el: HTMLElement): void {
      root = el;
      setTheme(getTheme());
      el.innerHTML =
        '<div class="login-card">' +
        '<button type="button" data-action="theme" title="Light mode">☀️</button>' +
        '<h1>OpenLocalPanel</h1>' +
        '<p>Local operations panel</p>' +
        '<input data-user placeholder="Username" autocomplete="username">' +
        '<input data-pass type="password" placeholder="Password" autocomplete="current-password">' +
        '<button type="button" data-action="login">Log in</button>' +
        '<p data-error></p>' +
        '</div>';
      paintTheme();
      const { signal } = aborter;
      el.querySelector('[data-action="theme"]')?.addEventListener('click', onTheme, { signal });
      el.querySelector('[data-action="login"]')?.addEventListener('click', () => void submit(), { signal });
      el.querySelector('[data-pass]')?.addEventListener(
        'keydown',
        (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') void submit();
        },
        { signal },
      );
    },
    unmount(): void {
      aborter.abort();
      root = null;
    },
  };
}
