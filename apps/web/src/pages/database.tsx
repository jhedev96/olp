import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { ComingSoon } from '../components/common/States.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

type Engine = 'mysql' | 'postgres';

/** Row + result shapes (server contract). */
export interface DbCellRow {
  [col: string]: unknown;
}
export interface DbResult {
  fields: string[];
  rows: DbCellRow[];
  affected?: number | null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

/** Result grid (Terwo `renderTable` parity, English empty/affected lines). */
export function ResultTable({ fields, rows, affected }: DbResult): ReactElement {
  if (rows.length === 0) return <p className="text-sm text-neutral-400">0 rows.</p>;
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            {fields.map((col) => (
              <th key={col} className="text-left font-medium">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i}>
              {fields.map((col) => (
                <td key={col} className="text-neutral-400">
                  {cellText(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {affected !== undefined && affected !== null && (
        <p className="mt-1 text-xs text-neutral-400">{affected} rows affected</p>
      )}
    </div>
  );
}

/**
 * Database manager (mockup database parity): engine tabs, config form
 * with test + save-and-connect, live server version, disconnect,
 * db/table browser, 50-row preview, Ctrl+Enter ad-hoc SQL runner.
 * Honestly omitted (no source, backend frozen): Redis engine (CAND-024),
 * create-database (CAND-006), import/export transfer (CAND-025), schema
 * DDL + sizes (CAND-026), socket/buffer lines. List failures keep the
 * previous render.
 */
export function DatabasePage(): ReactElement {
  const [engine, setEngine] = useState<Engine>('mysql');
  const [form, setForm] = useState({ host: '', port: '', user: '', password: '', database: '' });
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<{ db: string; list: string[] } | null>(null);
  const [result, setResult] = useState<DbResult | { error: string } | null>(null);
  const [sql, setSql] = useState('');
  const [version, setVersion] = useState('');

  /** Best-effort server version via a version query (hidden on failure). */
  const fetchVersion = useCallback(async (next: Engine): Promise<void> => {
    try {
      const body = await apiJson<DbResult>(`/api/db/${next}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: next === 'mysql' ? 'SELECT VERSION()' : 'SELECT version()' }),
      });
      const first = body.rows[0];
      const value = first === undefined ? undefined : Object.values(first)[0];
      if (typeof value === 'string' && value !== '') setVersion(value);
      else if (typeof value === 'number') setVersion(String(value));
    } catch {
      // version line stays hidden (older servers, restricted users)
    }
  }, []);

  const loadConfig = useCallback(async (next: Engine): Promise<void> => {
    setVersion('');
    try {
      const body = await apiJson<{ config: Record<string, unknown>; connected: boolean }>(`/api/db/${next}/config`);
      const cfg = body.config;
      setForm({
        host: typeof cfg['host'] === 'string' ? cfg['host'] : '',
        port: cfg['port'] !== undefined ? String(cfg['port']) : '',
        user: typeof cfg['user'] === 'string' ? cfg['user'] : '',
        password: '',
        database: typeof cfg['database'] === 'string' ? cfg['database'] : '',
      });
      setConnected(body.connected);
      if (body.connected) {
        const list = await apiJson<{ databases: string[] }>(`/api/db/${next}/databases`);
        setDatabases(list.databases);
        void fetchVersion(next);
      } else {
        setDatabases([]);
      }
      setTables(null);
    } catch {
      // keep the previous render (Terwo parity)
    }
  }, [fetchVersion]);

  useEffect(() => {
    void loadConfig(engine);
  }, [engine, loadConfig]);

  const formBody = (): Record<string, string> => ({
    host: form.host,
    port: form.port,
    user: form.user,
    password: form.password,
    database: form.database,
  });

  const testConnection = async (): Promise<void> => {
    setMessage('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>(`/api/db/${engine}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formBody()),
      });
      setMessage(body.ok === true ? 'Connection OK' : `Failed: ${typeof body.error === 'string' ? body.error : ''}`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const connect = async (): Promise<void> => {
    setMessage('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string; databases?: string[] }>(`/api/db/${engine}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formBody()),
      });
      if (body.ok === true) {
        setConnected(true);
        setDatabases(Array.isArray(body.databases) ? body.databases : []);
        setTables(null);
        void fetchVersion(engine);
      } else setMessage(typeof body.error === 'string' ? body.error : 'Connection failed');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Connection failed');
    }
  };

  const disconnect = async (): Promise<void> => {
    await apiJson(`/api/db/${engine}/disconnect`, { method: 'POST' }).catch(() => undefined);
    setConnected(false);
    setDatabases([]);
    setTables(null);
    setVersion('');
  };

  const openTables = async (db: string): Promise<void> => {
    try {
      const body = await apiJson<{ tables: string[] }>(`/api/db/${engine}/tables?db=${encodeURIComponent(db)}`);
      setTables({ db, list: body.tables });
    } catch {
      // keep previous
    }
  };

  const browse = async (db: string, table: string): Promise<void> => {
    setResult({ fields: [], rows: [], affected: null });
    try {
      const body = await apiJson<DbResult>(
        `/api/db/${engine}/rows?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`,
      );
      setResult(body);
    } catch (err) {
      setResult({ error: err instanceof ApiError ? err.message : 'Failed' });
    }
  };

  const runQuery = async (): Promise<void> => {
    setResult({ fields: [], rows: [], affected: null });
    try {
      const body = await apiJson<DbResult & { error?: string }>(`/api/db/${engine}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      if (typeof body.error === 'string' && !Array.isArray(body.rows)) setResult({ error: body.error });
      else setResult(body);
    } catch (err) {
      setResult({ error: err instanceof ApiError ? err.message : 'Failed' });
    }
  };

  const field = (key: keyof typeof form, placeholder: string, type = 'text'): ReactElement => (
    <Input placeholder={placeholder} type={type} value={form[key]} onChange={(ev) => setForm({ ...form, [key]: ev.target.value })} className="w-40" />
  );

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Database</h1>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {(['mysql', 'postgres'] as const).map((e) => (
          <Button key={e} size="sm" variant={engine === e ? 'default' : 'outline'} onClick={() => setEngine(e)}>
            {e === 'mysql' ? 'MySQL' : 'PostgreSQL'}
          </Button>
        ))}
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-024)">
          Redis
        </Button>
        <span className={connected ? 'ml-2 text-sm text-green-400' : 'ml-2 text-sm text-neutral-400'}>
          {connected ? `Connected (${engine})` : 'Not connected'}
        </span>
        {connected && version !== '' && <span className="font-mono text-xs text-neutral-400">{version}</span>}
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {field('host', 'Host (127.0.0.1)')}
        {field('port', engine === 'mysql' ? 'Port (3306)' : 'Port (5432)')}
        {field('user', 'User')}
        {field('password', 'Password', 'password')}
        {field('database', 'Database (optional)')}
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void testConnection()}>
          Test Connection
        </Button>
        <Button size="sm" onClick={() => void connect()}>
          Save &amp; Connect
        </Button>
        <Button size="sm" variant="outline" onClick={() => void disconnect()}>
          Disconnect
        </Button>
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-006)">
          New Database
        </Button>
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-025)">
          Import
        </Button>
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-025)">
          Export
        </Button>
      </div>
      {message !== '' && <p className="mb-3 text-sm text-neutral-300">{message}</p>}
      {connected && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <h2 className="mb-2 font-bold">Databases</h2>
            <div className="flex flex-col gap-1">
              {databases.map((db) => (
                <button key={db} type="button" className="text-left text-sm hover:text-green-400" onClick={() => void openTables(db)}>
                  {db}
                </button>
              ))}
            </div>
          </Card>
          <Card>
            <h2 className="mb-2 font-bold">Tables{tables !== null ? ` (${tables.db})` : ''}</h2>
            <div className="flex flex-col gap-1">
              {(tables?.list ?? []).map((table) => (
                <button
                  key={table}
                  type="button"
                  className="text-left text-sm hover:text-green-400"
                  onClick={() => tables !== null && void browse(tables.db, table)}
                >
                  {table}
                </button>
              ))}
            </div>
          </Card>
          <Card>
            <h2 className="mb-2 font-bold">SQL</h2>
            <textarea
              className="h-24 w-full rounded border border-neutral-700 bg-transparent p-2 font-mono text-sm"
              value={sql}
              onChange={(ev) => setSql(ev.target.value)}
              onKeyDown={(ev) => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') void runQuery();
              }}
              placeholder="SELECT * FROM users LIMIT 10"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={() => void runQuery()}>
                Run
              </Button>
              <span className="text-xs text-neutral-500">Ctrl+Enter runs</span>
            </div>
          </Card>
        </div>
      )}
      {connected && (
        <Card className="mt-3">
          {result === null ? (
            <p className="text-sm text-neutral-400">Pick a table or run SQL.</p>
          ) : 'error' in result ? (
            <p role="alert" className="text-sm text-red-400">
              {result.error}
            </p>
          ) : (
            <ResultTable fields={result.fields} rows={result.rows} affected={result.affected} />
          )}
        </Card>
      )}
      {connected && (
        <div className="mt-3">
          <ComingSoon feature="Schema sizes & DDL browser" candidate="CAND-026" />
        </div>
      )}
    </main>
  );
}
