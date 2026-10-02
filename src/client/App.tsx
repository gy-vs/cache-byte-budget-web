import {useEffect, useRef, useState} from 'react';
import {Database, FlaskConical, Play, RotateCw, Save} from 'lucide-react';

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
type EvictedInfo = {canonical: string; resource: string; revision: number; bytes: number};
type CacheInfo = {
  status: string;
  reason: string;
  key: CanonicalKey | null;
  invalidated?: string;
  stored?: boolean;
  notStoredReason?: string;
  evicted?: EvictedInfo[];
};
type CacheVariant = {canonical: string; revision: number; bytes: number; storedAt: number};
type CacheState = {
  budgetBytes: number | null;
  usedBytes: number;
  entryCount: number;
  resources: Array<{resource: string; bytes: number; variants: CacheVariant[]}>;
};

function decodeHeader<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

const decodeKey = (value: string | null) => decodeHeader<CanonicalKey>(value);

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
  // Shared server-side cache state (single cache for all resources).
  const [cacheState, setCacheState] = useState<CacheState | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [budgetNote, setBudgetNote] = useState<string | null>(null);
  const budgetInitialized = useRef(false);

  useEffect(() => {
    fetch('/api/experiments').then((r) => r.json()).then(setItems);
  }, []);

  async function refreshCache() {
    const response = await fetch('/api/cache');
    const state = (await response.json()) as CacheState;
    setCacheState(state);
    if (!budgetInitialized.current) {
      budgetInitialized.current = true;
      setBudgetDraft(state.budgetBytes === null ? '' : String(state.budgetBytes));
    }
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
    const storedHeader = response.headers.get('X-Cache-Stored');
    setCacheInfo({
      status: response.headers.get('X-Cache-Status') ?? '—',
      reason: response.headers.get('X-Cache-Reason') ?? '—',
      key: decodeKey(response.headers.get('X-Cache-Key')),
      stored: storedHeader === null ? undefined : storedHeader === 'true',
      notStoredReason: response.headers.get('X-Cache-Not-Stored-Reason') ?? undefined,
      evicted: decodeHeader<EvictedInfo[]>(response.headers.get('X-Cache-Evictions')) ?? [],
    });
    setStatus('Loaded');
    await refreshCache();
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

  async function applyBudget() {
    const trimmed = budgetDraft.trim();
    let budgetBytes: number | null = null;
    if (trimmed !== '') {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setBudgetNote('Enter a non-negative integer, or leave blank for unbounded.');
        return;
      }
      budgetBytes = parsed;
    }
    setStatus('Applying budget');
    const response = await fetch('/api/cache/budget', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({budgetBytes}),
    });
    const value = await response.json();
    if (!response.ok) {
      setBudgetNote('Budget rejected by the server.');
    } else {
      const label = value.budgetBytes === null ? 'unbounded' : `${value.budgetBytes} B`;
      setBudgetNote(
        value.evicted.length > 0
          ? `Budget ${label}: ${value.evicted.length} variant(s) no longer retained (freed ${value.evictedBytes} B).`
          : `Budget ${label}: all existing variants retained.`,
      );
    }
    await refreshCache();
    setStatus('Ready');
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

          <div className="capacity">
            <h3>Capacity — one shared server cache</h3>
            {cacheState ? (
              <>
                <div className="usageline">
                  {cacheState.usedBytes} / {cacheState.budgetBytes ?? '∞'} bytes ·{' '}
                  {cacheState.entryCount} variant(s)
                </div>
                <div className="meter">
                  <div
                    style={{
                      width: cacheState.budgetBytes
                        ? `${Math.min(100, (cacheState.usedBytes / cacheState.budgetBytes) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
                <label>
                  Entity budget in bytes (blank = unbounded)
                  <input
                    value={budgetDraft}
                    onChange={(event) => setBudgetDraft(event.target.value)}
                    placeholder="e.g. 600"
                    spellCheck={false}
                  />
                </label>
                <button onClick={applyBudget}>Apply budget</button>
                {budgetNote && <p className="hint">{budgetNote}</p>}
                {cacheState.resources.length === 0 ? (
                  <p className="hint">Cache is empty.</p>
                ) : (
                  cacheState.resources.map((group) => (
                    <div key={group.resource}>
                      <p className="resource">
                        {group.resource} — {group.bytes} B · {group.variants.length} variant(s)
                      </p>
                      <table>
                        <thead>
                          <tr>
                            <th>bytes</th>
                            <th>rev</th>
                            <th>variant key (LRU → MRU)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.variants.map((variant) => (
                            <tr key={variant.canonical}>
                              <td>{variant.bytes}</td>
                              <td>{variant.revision}</td>
                              <td>
                                <details>
                                  <summary>canonical</summary>
                                  <code>{variant.canonical}</code>
                                </details>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))
                )}
              </>
            ) : (
              <p>Loading cache state…</p>
            )}
          </div>

          {cacheInfo ? (
            <>
              <div className="badges">
                <span className={`pill status-${cacheInfo.status.toLowerCase()}`}>
                  {cacheInfo.status}
                </span>
                <span className="pill reason">{cacheInfo.reason}</span>
                {cacheInfo.stored === true && <span className="pill status-hit">retained</span>}
                {cacheInfo.stored === false && (
                  <span className="pill status-bypass">
                    not retained{cacheInfo.notStoredReason ? ` · ${cacheInfo.notStoredReason}` : ''}
                  </span>
                )}
                {cacheInfo.evicted && cacheInfo.evicted.length > 0 && (
                  <span className="pill">evicted {cacheInfo.evicted.length}</span>
                )}
                {cacheInfo.invalidated !== undefined && (
                  <span className="pill">invalidated {cacheInfo.invalidated}</span>
                )}
              </div>

              {cacheInfo.evicted && cacheInfo.evicted.length > 0 && (
                <div className="keycard">
                  <h3>Evicted to make room for this fill</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>resource</th>
                        <th>bytes</th>
                        <th>rev</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cacheInfo.evicted.map((entry) => (
                        <tr key={entry.canonical}>
                          <td>{entry.resource}</td>
                          <td>{entry.bytes}</td>
                          <td>{entry.revision}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

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
