import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtSize } from '../lib/format.js';
import { PromptDialog } from '../components/common/Dialog.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

type Engine = 'mysql' | 'postgres';

/** `/api/db/:engine/schema` row shape. */
export interface SchemaStat {
  name: string;
  rows: number | null;
  dataBytes: number | null;
  indexBytes: number | null;
}

/** `/api/db/:engine/ddl` shape (ddl null where the engine has no exact text). */
export interface TableDefView {
  ddl: string | null;
  columns: Array<{ name: string; type: string; nullable: boolean; def: string | null }> | null;
}

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
    <div className="overflow-x-auto">
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
    </div>
  );
}

/**
 * Database manager (mockup database parity): engine tabs, config form
 * with test + save-and-connect, live server version, disconnect,
 * db/table browser with row-count/size badges, DDL modal, data-vs-index
 * panel, New Database dialog, Ctrl+Enter ad-hoc SQL runner. Row counts
 * are engine estimates (InnoDB/reltuples — footnoted in UI).
 * Import/export transfer stays out (CAND-025); Redis stays out
 * (CAND-024).
 */
export function DatabasePage(): ReactElement {
  const [engine, setEngine] = useState<Engine>('mysql');
  const [form, setForm] = useState({ host: '', port: '', user: '', password: '', database: '' });
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<{ db: string; list: string[]; stats: SchemaStat[] } | null>(null);
  const [result, setResult] = useState<DbResult | { error: string } | null>(null);
  const [sql, setSql] = useState('');
  const [version, setVersion] = useState('');
  const [promptCreate, setPromptCreate] = useState(false);
  const [ddlView, setDdlView] = useState<{ table: string; def: TableDefView } | null>(null);
  const [copiedConn, setCopiedConn] = useState(false);
  const [tableQuery, setTableQuery] = useState('');

  /** Shell connection string composed from the loaded form (copyable). */
  const connectionString = (): string => {
    if (engine === 'mysql') {
      return `mysql -u ${form.user !== '' ? form.user : 'root'} -p -h ${form.host !== '' ? form.host : '127.0.0.1'} -P ${form.port !== '' ? form.port : '3306'}${form.database !== '' ? ` ${form.database}` : ''}`;
    }
    return `psql -h ${form.host !== '' ? form.host : '127.0.0.1'} -p ${form.port !== '' ? form.port : '5432'} -U ${form.user !== '' ? form.user : 'postgres'}${form.database !== '' ? ` -d ${form.database}` : ''}`;
  };

  const copyConnection = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(connectionString());
      setCopiedConn(true);
      setTimeout(() => setCopiedConn(false), 1600);
    } catch {
      // clipboard blocked: the string stays visible for manual copy
    }
  };
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
      const [tablesBody, statsBody] = await Promise.all([
        apiJson<{ tables: string[] }>(`/api/db/${engine}/tables?db=${encodeURIComponent(db)}`),
        apiJson<{ tables: SchemaStat[] }>(`/api/db/${engine}/schema?db=${encodeURIComponent(db)}`).catch(() => ({ tables: [] as SchemaStat[] })),
      ]);
      setTables({ db, list: tablesBody.tables, stats: statsBody.tables });
    } catch {
      // keep previous
    }
  };

  const confirmCreate = async (name: string): Promise<void> => {
    setPromptCreate(false);
    const trimmed = name.trim();
    if (trimmed === '') return;
    setMessage('');
    try {
      const body = await apiJson<{ ok?: unknown; databases?: unknown; error?: string }>(`/api/db/${engine}/databases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (body.ok === true) {
        setDatabases(Array.isArray(body.databases) ? body.databases : []);
        setMessage(`Database "${trimmed}" created`);
      } else setMessage(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const openDdl = async (db: string, table: string): Promise<void> => {
    try {
      const body = await apiJson<TableDefView>(
        `/api/db/${engine}/ddl?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`,
      );
      setDdlView({ table, def: body });
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Failed to load definition');
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
        <Button size="sm" variant="outline" onClick={() => setPromptCreate(true)}>
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
            <h2 className="mb-2 font-bold">Databases{databases.length > 0 ? ` (${databases.length})` : ''}</h2>
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
            <Input
              placeholder="Filter tables…"
              aria-label="Filter tables"
              value={tableQuery}
              onChange={(ev) => setTableQuery(ev.target.value)}
              className="mb-2"
            />
            <div className="flex flex-col gap-1">
              {(tables?.list ?? [])
                .filter((table) => table.toLowerCase().includes(tableQuery.trim().toLowerCase()))
                .map((table) => {
                  const stat = tables?.stats.find((s) => s.name === table);
                  return (
                    <div key={table} className="flex items-center gap-1">
                      <button
                        type="button"
                        className="mr-auto text-left text-sm hover:text-green-400"
                        onClick={() => tables !== null && void browse(tables.db, table)}
                      >
                        {table}
                        {stat !== undefined && (stat.rows !== null || stat.dataBytes !== null) && (
                          <span className="ml-2 font-mono text-[11px] text-neutral-500">
                            {stat.rows === null ? '?' : stat.rows} rows
                            {stat.dataBytes !== null && ` · ${fmtSize(stat.dataBytes)}`}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-neutral-400 hover:text-green-400"
                        onClick={() => tables !== null && void openDdl(tables.db, table)}
                      >
                        Schema
                      </button>
                    </div>
                  );
                })}
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
              <Button size="sm" variant="outline" onClick={() => setSql('')}>
                Clear
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
      {connected && tables !== null && (
        <Card className="mt-3">
          <h2 className="mb-1 font-bold">Data vs index ({tables.db})</h2>
          {(() => {
            const data = tables.stats.reduce((sum, s) => sum + (s.dataBytes ?? 0), 0);
            const index = tables.stats.reduce((sum, s) => sum + (s.indexBytes ?? 0), 0);
            const unknown = tables.stats.some((s) => s.dataBytes === null || s.indexBytes === null);
            const total = data + index;
            return (
              <>
                <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${total > 0 ? Math.round((data / total) * 100) : 0}%` }} />
                </div>
                <p className="mt-1 text-xs text-neutral-400">
                  {fmtSize(data)} data · {fmtSize(index)} index{unknown ? ' · some tables report no sizes' : ''}
                </p>
                <p className="text-[11px] text-neutral-500">Row counts are engine estimates (InnoDB/reltuples).</p>
              </>
            );
          })()}
        </Card>
      )}
      {connected && (
        <Card className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-bold">Connection string</h2>
            <Button size="sm" variant="outline" onClick={() => void copyConnection()}>
              {copiedConn ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <code className="mt-2 block truncate rounded bg-black/40 px-2 py-1 font-mono text-xs">{connectionString()}</code>
        </Card>
      )}
      <PromptDialog
        open={promptCreate}
        title="New database"
        placeholder="Database name (letters, digits, _ and $)"
        confirmLabel="Create"
        onSubmit={(name) => void confirmCreate(name)}
        onCancel={() => setPromptCreate(false)}
      />
      {ddlView !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-mono text-sm font-bold">Schema: {ddlView.table}</h2>
            {ddlView.def.ddl !== null ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{ddlView.def.ddl}</pre>
            ) : ddlView.def.columns !== null ? (
              <table className="w-full text-sm">
                <tbody>
                  {ddlView.def.columns.map((col) => (
                    <tr key={col.name}>
                      <td className="font-mono">{col.name}</td>
                      <td className="font-mono text-xs text-neutral-400">{col.type}</td>
                      <td className="text-xs text-neutral-400">{col.nullable ? 'NULL' : 'NOT NULL'}</td>
                      <td className="font-mono text-xs text-neutral-400">{col.def ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-neutral-400">No definition available.</p>
            )}
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => setDdlView(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
