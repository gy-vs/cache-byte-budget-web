import {useEffect, useState} from 'react';
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
type CacheInfo = {
  status: string;
  reason: string;
  key: CanonicalKey | null;
  invalidated?: string;
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

  useEffect(() => {
    fetch('/api/experiments').then((r) => r.json()).then(setItems);
  }, []);

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
      key: decodeKey(response.headers.get('X-Cache-Key')),
    });
    setStatus('Loaded');
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
        <small>Vary canonical keys</small>
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
                {cacheInfo.invalidated !== undefined && (
                  <span className="pill">invalidated {cacheInfo.invalidated}</span>
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
