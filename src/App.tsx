import {
  AlertTriangle, Archive, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, Clock3, Copy, ExternalLink, Folder,
  FolderOpen, Github, Layers3, Menu, PackageSearch, RefreshCw, Search,
  ShieldAlert, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import packageMetadata from '../package.json';
import type { InventoryPayload, OwnershipLabel, PortfolioDisposition, PortfolioReview, ProjectRecord, ScanStatus } from '../shared/types';

type View = 'overview' | 'projects' | 'portfolio' | 'review' | 'vendor' | 'duplicates' | 'history';
type Notice = { message: string; tone: 'success' | 'error' };

const PAGE_SIZE = 25;

const EMPTY_SCAN: ScanStatus = {
  state: 'idle', roots: ['D:\\'], currentPath: null, directoriesVisited: 0,
  projectsFound: 0, startedAt: null, completedAt: null, error: null,
  githubAvailable: false, geminiAvailable: false,
};

const NAV_ITEMS: Array<{ id: View; label: string; icon: typeof Archive }> = [
  { id: 'overview', label: 'Overview', icon: Archive },
  { id: 'projects', label: 'Projects', icon: Folder },
  { id: 'portfolio', label: 'Portfolio review', icon: BriefcaseBusiness },
  { id: 'review', label: 'Needs review', icon: AlertTriangle },
  { id: 'vendor', label: 'Vendor copies', icon: ShieldAlert },
  { id: 'duplicates', label: 'Duplicate groups', icon: Layers3 },
  { id: 'history', label: 'Scan history', icon: Clock3 },
];

function ownershipLabel(value: OwnershipLabel): string {
  return value === 'mine' ? 'Likely mine' : value === 'vendor' ? 'Vendor' : 'Needs review';
}

function githubLabel(project: ProjectRecord): string {
  switch (project.github.kind) {
    case 'exact-remote': return project.github.repositoryName ?? 'Matched remote';
    case 'name-match': return project.github.repositoryName ?? 'Name match';
    case 'different-owner': return 'Different owner';
    case 'unknown': return 'GitHub unavailable';
    default: return 'Not found';
  }
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const DISPOSITION_LABELS: Record<PortfolioDisposition, string> = {
  pending: 'Pending review',
  'publish-candidate': 'Ready for final gates',
  published: 'Published this review',
  'already-published': 'Already on GitHub',
  consolidate: 'Consolidate',
  'hold-rights': 'Hold: rights',
  'hold-security': 'Hold: disclosure',
  'hold-too-small': 'Hold: too small',
  'hold-duplicate': 'Hold: duplicate',
  'exclude-vendor': 'Excluded: vendor',
  'exclude-fixture': 'Excluded: fixture',
  'exclude-backup': 'Excluded: backup',
  'not-published': 'Not published',
};

const DISPOSITION_ORDER: PortfolioDisposition[] = [
  'published', 'publish-candidate', 'already-published', 'hold-security', 'hold-rights',
  'consolidate', 'hold-duplicate', 'hold-too-small', 'not-published', 'pending',
  'exclude-backup', 'exclude-fixture', 'exclude-vendor',
];

function formatDate(value: string | null): string {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatDuration(start: string | null, end?: string | null): string {
  if (!start) return '—';
  const elapsed = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function App() {
  const [inventory, setInventory] = useState<InventoryPayload>({ projects: [], scan: EMPTY_SCAN });
  const [view, setView] = useState<View>('projects');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(Date.now());

  async function loadInventory() {
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error('Could not load the local inventory.');
    const payload = await response.json() as InventoryPayload;
    setInventory(payload);
    setSelectedId((current) => current ?? payload.projects[0]?.id ?? null);
  }

  useEffect(() => {
    void loadInventory()
      .catch((error: Error) => setNotice({ message: error.message, tone: 'error' }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (inventory.scan.state !== 'running') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void loadInventory().catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [inventory.scan.state]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    inventory.projects.forEach((project) => counts.set(normalizeName(project.name), (counts.get(normalizeName(project.name)) ?? 0) + 1));
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [inventory.projects]);

  const reviewByProject = useMemo(() => new Map((inventory.reviews ?? []).map((review) => [review.projectId, review])), [inventory.reviews]);

  const filteredProjects = useMemo(() => {
    const search = query.trim().toLowerCase();
    const results = inventory.projects.filter((project) => {
      const portfolio = reviewByProject.get(project.id);
      if (view === 'portfolio' && !portfolio) return false;
      if (view === 'review' && project.ownership !== 'review') return false;
      if (view === 'vendor' && project.ownership !== 'vendor') return false;
      if (view === 'duplicates' && !duplicateNames.has(normalizeName(project.name))) return false;
      if (view === 'history') return false;
      return !search || [
        project.name, project.path, project.stack.join(' '), githubLabel(project),
        portfolio?.canonicalName ?? '', portfolio?.disposition ?? '', portfolio?.summary ?? '',
      ]
        .some((value) => value.toLowerCase().includes(search));
    });
    if (view === 'portfolio') {
      return results.sort((a, b) => {
        const left = reviewByProject.get(a.id)!;
        const right = reviewByProject.get(b.id)!;
        return DISPOSITION_ORDER.indexOf(left.disposition) - DISPOSITION_ORDER.indexOf(right.disposition)
          || right.significanceScore - left.significanceScore
          || a.name.localeCompare(b.name);
      });
    }
    return results;
  }, [duplicateNames, inventory.projects, query, reviewByProject, view]);

  const pageCount = Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const pageStart = (activePage - 1) * PAGE_SIZE;
  const visibleProjects = filteredProjects.slice(pageStart, pageStart + PAGE_SIZE);
  const selected = visibleProjects.find((project) => project.id === selectedId) ?? visibleProjects[0] ?? null;
  const counts = useMemo(() => ({
    mine: inventory.projects.filter((project) => project.ownership === 'mine').length,
    review: inventory.projects.filter((project) => project.ownership === 'review').length,
    vendor: inventory.projects.filter((project) => project.ownership === 'vendor').length,
  }), [inventory.projects]);
  const portfolioReadyCount = useMemo(() => (inventory.reviews ?? []).filter((review) => ['published', 'publish-candidate', 'already-published'].includes(review.disposition)).length, [inventory.reviews]);

  async function startScan() {
    setNotice(null);
    try {
      const roots = inventory.scan.roots.length ? inventory.scan.roots : ['D:\\'];
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roots }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        setNotice({ message: payload.error ?? 'The scan could not start.', tone: 'error' });
        return;
      }
      setSelectedId(null);
      setPage(1);
      await loadInventory();
    } catch {
      setNotice({ message: 'The local scanner could not be reached.', tone: 'error' });
    }
  }

  async function cancelScan() {
    try {
      const response = await fetch('/api/scan/cancel', { method: 'POST' });
      if (!response.ok) throw new Error();
    } catch {
      setNotice({ message: 'The scan cancellation request failed.', tone: 'error' });
    }
  }

  async function copyPath(project: ProjectRecord) {
    try {
      await navigator.clipboard.writeText(project.path);
      setNotice({ message: 'Machine path copied.', tone: 'success' });
      window.setTimeout(() => setNotice(null), 1800);
    } catch {
      setNotice({ message: 'The machine path could not be copied.', tone: 'error' });
    }
  }

  async function openFolder(project: ProjectRecord) {
    try {
      const response = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      });
      if (!response.ok) throw new Error();
    } catch {
      setNotice({ message: 'The local folder could not be opened.', tone: 'error' });
    }
  }

  const scanRunning = inventory.scan.state === 'running';
  const activeRoot = inventory.scan.roots[0] ?? 'D:\\';
  const viewTitle = NAV_ITEMS.find((item) => item.id === view)?.label ?? 'Projects';

  return (
    <div className="app-shell">
      {menuOpen && <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}
      <aside id="inventory-navigation" className={menuOpen ? 'sidebar sidebar--open' : 'sidebar'} aria-label="Project Provenance navigation">
        <div className="sidebar-brand">
          <Menu aria-hidden="true" />
          <button className="mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X /></button>
        </div>
        <nav aria-label="Inventory views">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? 'nav-item nav-item--active' : 'nav-item'}
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => { setView(item.id); setPage(1); setMenuOpen(false); }}
              >
                <Icon aria-hidden="true" /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="ownership-breakdown">
          <p className="utility-heading">Ownership breakdown</p>
          <BreakdownRow tone="mine" label="Likely mine" value={counts.mine} />
          <BreakdownRow tone="review" label="Needs review" value={counts.review} />
          <BreakdownRow tone="vendor" label="Vendor" value={counts.vendor} />
          <div className="breakdown-total"><span>Portfolio ready</span><strong>{portfolioReadyCount}</strong></div>
          <div className="breakdown-total"><span>Total projects</span><strong>{inventory.projects.length}</strong></div>
        </div>
        <p className="version">v{packageMetadata.version} · local inventory</p>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="inventory-navigation"><Menu /></button>
          <div>
            <h1>Project Provenance</h1>
          </div>
          <div className="root-control"><span>Root</span><code>{activeRoot}</code></div>
          <div className="topbar-actions">
            <span className="local-status"><i />Local only</span>
            {scanRunning ? (
              <button className="scan-button scan-button--stop" onClick={() => void cancelScan()}><X /> Stop scan</button>
            ) : (
              <button className="scan-button" onClick={() => void startScan()}><RefreshCw /> Scan {activeRoot}</button>
            )}
          </div>
        </header>

        <section className="scan-strip" aria-live="polite">
          <div className="scan-facts">
            <span><b>{scanRunning ? 'Scanning' : 'Status'}</b> <code>{scanRunning ? activeRoot : inventory.scan.state}</code></span>
            <span>Folders <strong>{inventory.scan.directoriesVisited.toLocaleString()}</strong></span>
            <span>Detected projects <strong>{inventory.projects.length.toLocaleString()}</strong></span>
            <span>Elapsed <strong>{formatDuration(inventory.scan.startedAt, scanRunning ? new Date(now).toISOString() : inventory.scan.completedAt)}</strong></span>
            <span className="scan-state">{scanRunning ? 'In progress…' : inventory.scan.completedAt ? `Updated ${formatDate(inventory.scan.completedAt)}` : 'Ready to scan'}</span>
          </div>
          <div className={scanRunning ? 'progress-line progress-line--active' : 'progress-line'}><span /></div>
          {scanRunning && inventory.scan.currentPath && <p className="current-path">Reading <code>{inventory.scan.currentPath}</code></p>}
        </section>

        {notice && <div className={notice.tone === 'error' ? 'notice notice--error' : 'notice'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}{notice.message}<button onClick={() => setNotice(null)} aria-label="Dismiss"><X /></button></div>}
        {inventory.scan.error && <div className="error-banner" role="alert">{inventory.scan.error}</div>}

        <div className="content-grid">
          <section className="project-region">
            <div className="table-tools">
              <div><h2>{viewTitle}</h2><p>{filteredProjects.length} visible projects</p></div>
              {view !== 'history' && <label className="search-box"><Search aria-hidden="true" /><span className="sr-only">Search projects</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search name, path, stack…" /></label>}
            </div>
            {view === 'history' ? (
              <ScanHistory scan={inventory.scan} />
            ) : loading ? (
              <LoadingState />
            ) : filteredProjects.length ? (
              <div className="project-list">
                <div className="table-wrap">
                  <table>
                  <thead><tr><th>Project</th><th>Machine path</th><th>Ownership</th><th>GitHub</th><th>{view === 'portfolio' ? 'Portfolio decision' : 'Stack'}</th><th>{view === 'portfolio' ? 'Score' : 'Last changed'}</th></tr></thead>
                  <tbody>
                    {visibleProjects.map((project) => (
                      <tr key={project.id} className={selected?.id === project.id ? 'selected-row' : ''} aria-selected={selected?.id === project.id} onClick={() => setSelectedId(project.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(project.id); } }}>
                        <td><strong>{project.name}</strong>{project.aiAssisted && <small>AI signals</small>}</td>
                        <td><code title={project.path}>{project.path}</code></td>
                        <td><OwnershipBadge value={project.ownership} /></td>
                        <td><GitHubCell project={project} review={reviewByProject.get(project.id)} /></td>
                        {view === 'portfolio' ? <>
                          <td><PortfolioBadge review={reviewByProject.get(project.id)} /></td>
                          <td><strong>{reviewByProject.get(project.id)?.significanceScore ?? 0}/30</strong></td>
                        </> : <>
                          <td>{project.stack.length ? project.stack.join(', ') : 'Unknown'}</td>
                          <td>{formatDate(project.lastChangedAt)}</td>
                        </>}
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
                <Pagination
                  page={activePage}
                  pageCount={pageCount}
                  start={pageStart + 1}
                  end={Math.min(pageStart + PAGE_SIZE, filteredProjects.length)}
                  total={filteredProjects.length}
                  onPage={(nextPage) => { setPage(nextPage); setSelectedId(null); }}
                />
              </div>
            ) : (
              <EmptyState scanRunning={scanRunning} view={view} onScan={() => void startScan()} />
            )}
          </section>

          <aside className="inspector" aria-label="Selected project details">
            {selected ? <ProjectInspector project={selected} review={reviewByProject.get(selected.id)} onCopy={copyPath} onOpen={openFolder} /> : <InspectorEmpty scanRunning={scanRunning} />}
          </aside>
        </div>
      </main>
    </div>
  );
}

function BreakdownRow({ tone, label, value }: { tone: OwnershipLabel; label: string; value: number }) {
  return <div className="breakdown-row"><span><i className={`dot dot--${tone}`} />{label}</span><strong>{value}</strong></div>;
}

function OwnershipBadge({ value }: { value: OwnershipLabel }) {
  return <span className={`ownership ownership--${value}`}><i />{ownershipLabel(value)}</span>;
}

function PortfolioBadge({ review }: { review?: PortfolioReview }) {
  if (!review) return <span className="portfolio-badge portfolio-badge--pending">Not reviewed</span>;
  return <span className={`portfolio-badge portfolio-badge--${review.disposition}`}>{DISPOSITION_LABELS[review.disposition]}</span>;
}

function GitHubCell({ project, review }: { project: ProjectRecord; review?: PortfolioReview }) {
  const publication = review?.publication;
  if (publication) return <a className="repo-link" href={publication.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><Github />{publication.owner}/{publication.repository}<ExternalLink /></a>;
  const label = githubLabel(project);
  return project.github.repositoryUrl ? (
    <a className="repo-link" href={project.github.repositoryUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><Github />{label}<ExternalLink /></a>
  ) : <span className={`github-state github-state--${project.github.kind}`}>{label}</span>;
}

function Pagination({ page, pageCount, start, end, total, onPage }: { page: number; pageCount: number; start: number; end: number; total: number; onPage: (page: number) => void }) {
  return <nav className="pagination" aria-label="Project pages"><p>Showing <strong>{start}–{end}</strong> of <strong>{total}</strong> projects</p><div><button onClick={() => onPage(page - 1)} disabled={page === 1} aria-label="Previous project page"><ChevronLeft /></button><span>Page <strong>{page}</strong> of {pageCount}</span><button onClick={() => onPage(page + 1)} disabled={page === pageCount} aria-label="Next project page"><ChevronRight /></button></div></nav>;
}

function ProjectInspector({ project, review, onCopy, onOpen }: { project: ProjectRecord; review?: PortfolioReview; onCopy: (project: ProjectRecord) => void; onOpen: (project: ProjectRecord) => void }) {
  const segments = project.path.replace(/^[\\/]+|[\\/]+$/g, '').split(/[\\/]+/);
  const reviewEvidence = review?.evidence.slice(0, 8) ?? [];
  const reviewRisks = review?.risks.slice(0, 6) ?? [];
  return (
    <div className="inspector-inner">
      <div className="inspector-heading"><div><h2>{project.name}</h2><p>Selected project</p></div><OwnershipBadge value={project.ownership} /></div>
      <section className="inspector-section">
        <p className="utility-heading">Path ribbon (exact)</p>
        <div className="path-ribbon">{segments.map((segment, index) => <span key={`${segment}-${index}`}>{segment}</span>)}</div>
        <p className="field-label">Exact machine path</p>
        <div className="copy-field"><code>{project.path}</code><button onClick={() => void onCopy(project)} aria-label="Copy machine path"><Copy /></button></div>
      </section>
      <section className="inspector-section portfolio-review">
        <p className="utility-heading">Portfolio review</p>
        {review ? <>
          <div className="portfolio-review-heading"><PortfolioBadge review={review} /><strong>{review.significanceScore}/30</strong></div>
          <p className="portfolio-summary">{review.summary}</p>
          <div className="portfolio-metrics">
            <span><strong>{review.metrics.sourceFiles}</strong> source files</span>
            <span><strong>{review.metrics.sourceLines.toLocaleString()}</strong> source lines</span>
            <span><strong>{review.metrics.testFiles}</strong> test files</span>
            <span><strong>{review.metrics.commits}</strong> commits</span>
          </div>
          <p className="field-label">Portfolio ownership</p>
          <p className="review-value">{review.ownershipVerdict.replaceAll('-', ' ')} · rights {review.rightsVerdict.replaceAll('-', ' ')}</p>
          {reviewEvidence.length > 0 && <><p className="field-label">Review evidence</p><ul className="evidence-list">{reviewEvidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}{review.evidence.length > reviewEvidence.length && <li className="evidence-more">+{review.evidence.length - reviewEvidence.length} more in the portfolio audit report.</li>}</ul></>}
          {reviewRisks.length > 0 && <><p className="field-label">Open gates</p><ul className="evidence-list evidence-list--risks">{reviewRisks.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}{review.risks.length > reviewRisks.length && <li className="evidence-more">+{review.risks.length - reviewRisks.length} more in the portfolio audit report.</li>}</ul></>}
          {review.publication && <p className="context-note context-note--success">Published at <a href={review.publication.url} target="_blank" rel="noreferrer">{review.publication.owner}/{review.publication.repository}<ExternalLink /></a></p>}
        </> : <p className="context-note">This project has not yet received a portfolio publication review.</p>}
      </section>
      <section className="inspector-section">
        <p className="utility-heading">Ownership</p>
        <div className="confidence-line"><OwnershipBadge value={project.ownership} /><strong>{project.ownershipConfidence}% confidence</strong></div>
        <p className="field-label">Evidence</p>
        <ul className="evidence-list">
          {project.ownershipReasons.length ? project.ownershipReasons.map((reason) => <li key={reason.code}>{reason.label}</li>) : <li>No strong ownership evidence yet.</li>}
          {project.aiSignals.map((signal) => <li key={signal}>{signal}</li>)}
        </ul>
      </section>
      <section className="inspector-section details-list">
        <div><span>Local Git branch</span><code>{project.git.branch ?? (project.git.isRepository ? 'detached / unborn' : 'not a Git repo')}</code></div>
        <div><span>Remote status</span><code>{project.git.remote ? 'origin present' : 'no origin remote'}</code></div>
        <div><span>GitHub on NilhanHub</span>{project.github.repositoryUrl ? <a href={project.github.repositoryUrl} target="_blank" rel="noreferrer">{project.github.repositoryName}<ExternalLink /></a> : <strong>{githubLabel(project)}</strong>}</div>
        {project.github.kind === 'different-owner' && <p className="context-note context-note--warning">The local remote points to {project.github.remoteOwner}/{project.github.remoteRepository}, not NilhanHub.</p>}
        {project.github.kind === 'not-found' && <p className="context-note">No NilhanHub repository name matches this local project. It may be local-only or published under another name.</p>}
        {project.github.kind === 'unknown' && <p className="context-note context-note--warning">GitHub CLI was unavailable during this scan, so NilhanHub status is unknown.</p>}
      </section>
      <div className="inspector-actions"><button onClick={() => void onOpen(project)}><FolderOpen />Open folder</button><button className="secondary-button" onClick={() => void onCopy(project)}><Copy />Copy path</button></div>
    </div>
  );
}

function EmptyState({ scanRunning, view, onScan }: { scanRunning: boolean; view: View; onScan: () => void }) {
  return <div className="empty-state"><PackageSearch /><h3>{scanRunning ? 'Projects will appear as they are found' : view === 'duplicates' ? 'No duplicate project names found' : 'No projects in this view'}</h3><p>{scanRunning ? 'The scanner is traversing trusted folders without changing their contents.' : 'Run a fresh local scan or choose a different inventory view.'}</p>{!scanRunning && <button onClick={onScan}><RefreshCw />Scan D:\</button>}</div>;
}

function LoadingState() {
  return <div className="empty-state loading-state" role="status"><RefreshCw /><h3>Loading local inventory</h3><p>Reading the saved project map from this computer.</p></div>;
}

function InspectorEmpty({ scanRunning }: { scanRunning: boolean }) {
  return <div className="inspector-empty"><Folder /><h3>{scanRunning ? 'Waiting for a project' : 'Select a project'}</h3><p>Exact paths, ownership evidence, Git status, and NilhanHub matches appear here.</p></div>;
}

function ScanHistory({ scan }: { scan: ScanStatus }) {
  return <div className="history-panel"><Clock3 /><div><h3>Latest local scan</h3><p>{scan.startedAt ? `Started ${formatDate(scan.startedAt)}` : 'No scan has run yet.'}</p></div><dl><div><dt>State</dt><dd>{scan.state}</dd></div><div><dt>Roots</dt><dd><code>{scan.roots.join(', ')}</code></dd></div><div><dt>Folders</dt><dd>{scan.directoriesVisited.toLocaleString()}</dd></div><div><dt>Projects</dt><dd>{scan.projectsFound.toLocaleString()}</dd></div><div><dt>GitHub</dt><dd>{scan.githubAvailable ? 'Available' : 'Unavailable / not checked'}</dd></div></dl></div>;
}

export default App;
