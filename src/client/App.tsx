import {useEffect, useState} from 'react';
import {Database, FlaskConical, Gauge, Play, RotateCw, Save} from 'lucide-react';

type Summary = {id: string; name: string; revision: number; vary: string; updatedAt: string};
type Row = Summary & {content: string};

type KeyComponent = {
  field: string;
  present: boolean;
  mergeable: boolean;
  values: string[];
};
type CanonicalKey = {
  resource: string;
  varyFields: string[];
  components: KeyComponent[];
  canonical: string;
  bypass: boolean;
};
type CacheInfo = {
  status: string;
  reason: string;
  missCause?: string;
  key: CanonicalKey | null;
  invalidated?: string;
  retained?: string;
  retainedReason?: string;
  entryBytes?: string;
  evicted?: string;
  evictedBytes?: string;
};

type EvictedEntry = {canonical: string; resource: string; bytes: number};
type StatsEntry = {
  canonical: string;
  resource: string;
  revision: number;
  bytes: number;
  storedAt: number;
  contentEncoding: string;
};
type CacheStats = {
  budgetBytes: number | null;
  usedBytes: number;
  entryCount: number;
  entries: StatsEntry[];
  resources: Array<{resource: string; variants: number; bytes: number}>;
};

function decodeKey(value: string | null): CanonicalKey | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as CanonicalKey;
  } catch {
    return null;
  }
}

/** "/api/experiments/alpha" -> "alpha" for compact tables. */
function shortResource(resource: string) {
  return resource.split('/').filter(Boolean).pop() ?? resource;
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<Row | null>(null);
  const [draft, setDraft] = useState('');
  const [varyDraft, setVaryDraft] = useState('');
  const [analysis, setAnalysis] = useState<unknown>(null);
  const [status, setStatus] = useState('Ready');
  // Request headers for the replay panel — sent verbatim, never keyed client-side.
  const [xLocale, setXLocale] = useState('en-US');
  const [acceptLanguage, setAcceptLanguage] = useState('en, fr;q=0.9');
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  // Capacity workbench — always read back from the one server-side cache.
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [budgetEvicted, setBudgetEvicted] = useState<EvictedEntry[] | null>(null);

  useEffect(() => {
    fetch('/api/experiments').then((r) => r.json()).then(setItems);
    refreshStats();
  }, []);

  async function refreshStats() {
    const response = await fetch('/api/cache/stats');
    setStats((await response.json()) as CacheStats);
  }

  async function load(id: string, opts?: {replay?: boolean}) {
    const headers: Record<string, string> = {};
    if (opts?.replay) {
      headers['X-Locale'] = xLocale;
      headers['Accept-Language'] = acceptLanguage;
    }
    setStatus(opts?.replay ? 'Replaying' : 'Loading');
    const response = await fetch('/api/experiments/' + id, {headers});
    const value = (await response.json()) as Row;
    setRow(value);
    setDraft(value.content);
    setVaryDraft(value.vary);
    setCacheInfo({
      status: response.headers.get('X-Cache-Status') ?? '—',
      reason: response.headers.get('X-Cache-Reason') ?? '—',
      missCause: response.headers.get('X-Cache-Miss-Cause') ?? undefined,
      key: decodeKey(response.headers.get('X-Cache-Key')),
      retained: response.headers.get('X-Cache-Retained') ?? undefined,
      retainedReason: response.headers.get('X-Cache-Retained-Reason') ?? undefined,
      entryBytes: response.headers.get('X-Cache-Entry-Bytes') ?? undefined,
      evicted: response.headers.get('X-Cache-Evicted') ?? undefined,
      evictedBytes: response.headers.get('X-Cache-Evicted-Bytes') ?? undefined,
    });
    setStatus('Loaded');
    await refreshStats();
  }

  useEffect(() => {
    load(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function save() {
    if (!row) return;
    setStatus('Saving');
    const response = await fetch('/api/experiments/' + row.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: draft, vary: varyDraft, revision: row.revision}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus('Revision conflict');
      return;
    }
    setRow(value);
    setStatus('Saved');
    setItems((prev) => prev.map((item) => (item.id === value.id ? value : item)));
    // Re-request through the cache to show the revision invalidation miss.
    await load(value.id);
    setCacheInfo((prev) =>
      prev
        ? {...prev, invalidated: response.headers.get('X-Cache-Invalidated') ?? '0'}
        : prev,
    );
  }

  async function applyBudget(value: number | null) {
    setStatus('Applying budget');
    const response = await fetch('/api/cache/budget', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({budgetBytes: value}),
    });
    if (!response.ok) {
      setStatus('Budget rejected');
      return;
    }
    const data = (await response.json()) as CacheStats & {evicted: EvictedEntry[]};
    setStats(data);
    setBudgetEvicted(data.evicted);
    setStatus(value === null ? 'Budget cleared' : `Budget set to ${value} B`);
  }

  function applyBudgetInput() {
    const trimmed = budgetInput.trim();
    if (trimmed === '') {
      void applyBudget(null);
      return;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 0) {
      setStatus('Budget must be a non-negative integer of bytes');
      return;
    }
    void applyBudget(value);
  }

  async function analyze() {
    if (!row) return;
    setStatus('Analyzing');
    const response = await fetch('/api/experiments/' + row.id + '/analyze', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: draft}),
    });
    setAnalysis(await response.json());
    setStatus('Ready');
  }

  const usagePercent =
    stats && stats.budgetBytes !== null && stats.budgetBytes > 0
      ? Math.min(100, Math.round((stats.usedBytes / stats.budgetBytes) * 100))
      : stats && stats.budgetBytes === 0 && stats.usedBytes > 0
        ? 100
        : 0;

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>HTTP Cache Lab</strong>
        <small>Vary canonical keys · bounded capacity</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">
            {items.map((item) => (
              <button
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
                key={item.id}
              >
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}>
              <Save size={15} />
              Save
            </button>
            <button onClick={analyze}>
              <Play size={15} />
              Analyze
            </button>
            <span>{status}</span>
          </div>

          <div className="replay">
            <h3>
              <RotateCw size={14} /> Replay headers
            </h3>
            <label>
              X-Locale (non-mergeable, sequence preserved)
              <input
                value={xLocale}
                onChange={(event) => setXLocale(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              Accept-Language (mergeable, tokens normalized)
              <input
                value={acceptLanguage}
                onChange={(event) => setAcceptLanguage(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              Response Vary (saved with the record; try <code>*</code>)
              <input
                value={varyDraft}
                onChange={(event) => setVaryDraft(event.target.value)}
                spellCheck={false}
              />
            </label>
            <button className="primary" onClick={() => load(selected, {replay: true})}>
              <RotateCw size={14} /> Send request
            </button>
            <p className="hint">
              Identical requests hit the same entry; change order/case of mergeable tokens
              and replay — non-mergeable value order stays distinct.
            </p>
          </div>

          <textarea
            aria-label="Content"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </section>

        <aside className="pane inspect">
          <h2>
            <Database size={15} /> Cache inspection
          </h2>
          {cacheInfo ? (
            <>
              <div className="badges">
                <span className={`pill status-${cacheInfo.status.toLowerCase()}`}>
                  {cacheInfo.status}
                </span>
                <span className="pill reason">{cacheInfo.reason}</span>
                {cacheInfo.status === 'MISS' && cacheInfo.missCause && (
                  <span className="pill cause">cause: {cacheInfo.missCause}</span>
                )}
                {cacheInfo.retained !== undefined && (
                  <span className={`pill ${cacheInfo.retained === 'true' ? 'kept' : 'dropped'}`}>
                    {cacheInfo.retained === 'true'
                      ? 'retained'
                      : `not retained · ${cacheInfo.retainedReason}`}
                  </span>
                )}
                {cacheInfo.evicted !== undefined && cacheInfo.evicted !== '0' && (
                  <span className="pill evicted">
                    evicted {cacheInfo.evicted} ({cacheInfo.evictedBytes} B)
                  </span>
                )}
                {cacheInfo.entryBytes !== undefined && (
                  <span className="pill">{cacheInfo.entryBytes} B stored</span>
                )}
                {cacheInfo.invalidated !== undefined && (
                  <span className="pill">invalidated {cacheInfo.invalidated}</span>
                )}
              </div>

              <div className="keycard capacity">
                <h3>
                  <Gauge size={13} /> Capacity — one shared server cache
                </h3>
                <div className="budgetrow">
                  <input
                    value={budgetInput}
                    onChange={(event) => setBudgetInput(event.target.value)}
                    placeholder="budget in bytes (empty = no limit)"
                    spellCheck={false}
                  />
                  <button onClick={applyBudgetInput}>Apply</button>
                  <button
                    onClick={() => {
                      setBudgetInput('');
                      void applyBudget(null);
                    }}
                  >
                    No limit
                  </button>
                </div>
                {stats ? (
                  <>
                    <p className="usage">
                      {stats.usedBytes} / {stats.budgetBytes ?? '∞'} B ·{' '}
                      {stats.entryCount} variant{stats.entryCount === 1 ? '' : 's'} stored
                    </p>
                    <div className="meter">
                      <span style={{width: `${usagePercent}%`}} />
                    </div>
                    {stats.resources.length > 0 && (
                      <table>
                        <thead>
                          <tr>
                            <th>resource</th>
                            <th>variants</th>
                            <th>bytes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.resources.map((resource) => (
                            <tr key={resource.resource}>
                              <td>{shortResource(resource.resource)}</td>
                              <td>{resource.variants}</td>
                              <td>{resource.bytes}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {stats.entries.length > 0 && (
                      <table>
                        <thead>
                          <tr>
                            <th>variant</th>
                            <th>rev</th>
                            <th>encoding</th>
                            <th>bytes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.entries.map((entry) => (
                            <tr key={entry.canonical}>
                              <td>
                                <span className="vresource">
                                  {shortResource(entry.resource)}
                                </span>
                                <code className="canon" title={entry.canonical}>
                                  {entry.canonical}
                                </code>
                              </td>
                              <td>{entry.revision}</td>
                              <td>{entry.contentEncoding}</td>
                              <td>{entry.bytes}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <p className="hint">
                      Most recently used first — capacity eviction takes from the bottom.
                      Bytes are the stored response entities (gzip costs less than
                      identity).
                    </p>
                  </>
                ) : (
                  <p>Reading cache stats…</p>
                )}
                {budgetEvicted && budgetEvicted.length > 0 && (
                  <div className="evictedlist">
                    <strong>Budget change evicted {budgetEvicted.length}:</strong>
                    <ul>
                      {budgetEvicted.map((entry) => (
                        <li key={entry.canonical}>
                          {shortResource(entry.resource)} · {entry.bytes} B ·{' '}
                          <code className="canon" title={entry.canonical}>
                            {entry.canonical}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {cacheInfo.key ? (
                cacheInfo.key.bypass ? (
                  <div className="keycard">
                    <strong>Vary: *</strong>
                    <p>Response is never reusable; every request bypasses the cache.</p>
                  </div>
                ) : (
                  <div className="keycard">
                    <h3>Key components (server-built)</h3>
                    <p className="resource">{cacheInfo.key.resource}</p>
                    <table>
                      <thead>
                        <tr>
                          <th>field</th>
                          <th>values</th>
                          <th>rule</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cacheInfo.key.components.map((component) => (
                          <tr key={component.field}>
                            <td>{component.field}</td>
                            <td>
                              {component.present ? (
                                component.values.length > 0 ? (
                                  <ol className="values">
                                    {component.values.map((value, index) => (
                                      <li key={index}>{value || <em>(empty)</em>}</li>
                                    ))}
                                  </ol>
                                ) : (
                                  <em>present, empty</em>
                                )
                              ) : (
                                <em>missing</em>
                              )}
                            </td>
                            <td>
                              <span className="rule">
                                {component.mergeable ? 'merged tokens' : 'value sequence'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <details>
                      <summary>canonical string</summary>
                      <code>{cacheInfo.key.canonical}</code>
                    </details>
                  </div>
                )
              ) : (
                <p>No structured key returned.</p>
              )}
            </>
          ) : (
            <p>Send a request to inspect its cache key.</p>
          )}

          {analysis != null && (
            <>
              <h3>Analysis</h3>
              <pre>{JSON.stringify(analysis, null, 2)}</pre>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
