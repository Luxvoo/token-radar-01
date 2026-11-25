const R = window.RADAR;
const rows = R.rows;
const liveRows = R.live;
const params = new URLSearchParams(location.search);
const state = {
  mode: params.get('mode') === 'live' ? 'live' : 'pre',
  q: params.get('q') || '',
  cat: params.get('category') || 'all',
  sortKey: 'rank',
  sortDir: 1,
  selected: params.get('detail') || rows[0].slug,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return money(n);
};
const pct = (n) => n === null || n === undefined ? 'n/a' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
const badge = (r) => `<span class="badge ${esc(r.confidence)}">${esc(r.confidence)} · n=${r.peer_n}</span>`;

function renderStats() {
  $('snapshot').textContent = `Snapshot ${R.meta.as_of} · ${R.meta.protocol_count} protocols`;
  $('stats').innerHTML = [
    [`${R.meta.watchlist_count}/${R.meta.watchlist_count}`, 'watchlist covered'],
    [R.meta.board_rows, 'board rows'],
    [R.meta.early_rows, 'early below $50M floor'],
    [R.meta.live_rows, 'live tokens set aside'],
  ].map(([v, label]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join('');
}

function renderDeciles() {
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  const groups = [];
  for (let i = 0; i < 10; i++) {
    const start = Math.floor((i * sorted.length) / 10);
    const end = Math.floor(((i + 1) * sorted.length) / 10);
    const slice = sorted.slice(start, end);
    groups.push({ label: `${start + 1}-${end}`, total: slice.reduce((s, r) => s + r.implied_value_usd, 0) });
  }
  const logs = groups.map((g) => Math.log10(g.total));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  $('deciles').innerHTML = groups.map((g, i) => {
    const h = 12 + ((logs[i] - min) / Math.max(max - min, 0.001)) * 72;
    return `<div class="decile"><strong>${compact(g.total)}</strong><div class="bar" style="height:${h}px"></div><small>Ranks ${g.label}</small></div>`;
  }).join('');
}

function currentRows() {
  const base = state.mode === 'live' ? liveRows : rows;
  const q = state.q.trim().toLowerCase();
  const filtered = base.filter((r) => {
    const inCat = state.cat === 'all' || r.category === state.cat;
    const inQ = !q || r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q);
    return inCat && inQ;
  });
  const key = state.sortKey;
  const val = (r) => key === 'chains' ? r.chains.length : key === 'name' || key === 'category' ? r[key].toLowerCase() : r[key];
  return filtered.sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : a.rank - b.rank;
    return cmp * state.sortDir;
  });
}

function header(key, label, num = false) {
  const mark = state.sortKey === key ? (state.sortDir === 1 ? '▲' : '▼') : '↕';
  return `<th class="${num ? 'num' : ''}"><button type="button" data-sort="${key}">${label}<span>${mark}</span></button></th>`;
}

function renderTable() {
  const list = currentRows();
  $('count').textContent = `${list.length} shown`;
  const live = state.mode === 'live';
  const head = live
    ? `<tr>${header('rank', 'Rank', true)}${header('name', 'Protocol')}${header('category', 'Category')}${header('tvl_usd', 'TVL', true)}${header('mcap_usd', 'Market cap', true)}${header('change_7d', '7d', true)}${header('age_days', 'Age', true)}${header('chains', 'Chains', true)}${header('peer_n', 'Confidence')}</tr>`
    : `<tr>${header('rank', 'Rank', true)}${header('name', 'Protocol')}${header('category', 'Category')}${header('tvl_usd', 'TVL', true)}${header('change_7d', '7d', true)}${header('age_days', 'Age', true)}${header('chains', 'Chains', true)}${header('implied_value_usd', 'Implied value', true)}${header('peer_n', 'Confidence')}</tr>`;
  const body = list.map((r) => {
    const selected = r.slug === state.selected ? ' class="selected"' : '';
    const change = `<span class="${(r.change_7d ?? 0) < 0 ? 'neg' : 'pos'}">${pct(r.change_7d)}</span>`;
    if (live) {
      return `<tr data-slug="${esc(r.slug)}"${selected}><td class="num">${r.rank}</td><td class="proto"><b>${esc(r.name)}</b><small>${esc(r.slug)}</small></td><td>${esc(r.category)}</td><td class="num">${compact(r.tvl_usd)}</td><td class="num">${compact(r.mcap_usd)}</td><td class="num">${change}</td><td class="num">${r.age_days}d</td><td class="num">${r.chains.length}</td><td>${badge(r)}</td></tr>`;
    }
    return `<tr data-slug="${esc(r.slug)}"${selected}><td class="num">${r.rank}</td><td class="proto"><b>${esc(r.name)}</b><small>${esc(r.slug)}${r.watchlist ? ' · watchlist' : ' · early'}</small></td><td>${esc(r.category)}</td><td class="num">${compact(r.tvl_usd)}</td><td class="num">${change}</td><td class="num">${r.age_days}d</td><td class="num">${r.chains.length}</td><td class="num"><b>${compact(r.implied_value_usd)}</b><div class="range">${compact(r.value_low)}–${compact(r.value_high)}</div></td><td>${badge(r)}</td></tr>`;
  }).join('');
  $('board').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const key = b.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir *= -1;
    else { state.sortKey = key; state.sortDir = key === 'rank' || key === 'name' || key === 'category' ? 1 : -1; }
    renderTable();
  }));
  document.querySelectorAll('tbody tr[data-slug]').forEach((tr) => tr.addEventListener('click', () => {
    state.selected = tr.getAttribute('data-slug');
    renderTable();
    renderDetail();
  }));
}

function selectedRow() {
  const base = state.mode === 'live' ? liveRows : rows;
  return base.find((r) => r.slug === state.selected) || base[0];
}

function renderDetail() {
  const r = selectedRow();
  if (!r) return;
  state.selected = r.slug;
  if (state.mode === 'live') {
    $('detail').innerHTML = `
      <h2>${esc(r.name)}</h2><p class="slug">${esc(r.slug)} · live token set aside from the pre-token ranking</p>
      <div>${badge(r)}</div>
      <div class="grid">
        <div class="kv"><span>Market cap</span><b>${money(r.mcap_usd)}</b></div>
        <div class="kv"><span>TVL</span><b>${money(r.tvl_usd)}</b></div>
        <div class="kv"><span>Market cap / TVL</span><b>${r.ratio.toFixed(3)}</b></div>
        <div class="kv"><span>7-day TVL change</span><b>${pct(r.change_7d)}</b></div>
        <div class="kv"><span>Age tracked</span><b>${r.age_days} days</b></div>
        <div class="kv"><span>Chains</span><b>${r.chains.length}</b></div>
      </div>
      <p class="muted">${esc(r.chains.join(', '))}</p>`;
    return;
  }
  const recomputed = Math.round(r.tvl_usd * r.peer_multiple * r.growth_mult * r.maturity_mult * r.breadth_mult);
  const logPos = (Math.log10(r.implied_value_usd) - Math.log10(r.value_low)) / Math.max(Math.log10(r.value_high) - Math.log10(r.value_low), 0.001) * 100;
  const flags = r.risk_flags.length
    ? `<div class="flags">${r.risk_flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</div>`
    : '<p class="noflags">No major flags from the snapshot fields.</p>';
  $('detail').innerHTML = `
    <h2>#${r.rank} ${esc(r.name)}</h2><p class="slug">${esc(r.slug)} · ${esc(r.category)} · ${r.watchlist ? 'watchlist' : 'early below floor'}</p>
    <div>${badge(r)}</div>
    <div class="grid">
      <div class="kv"><span>Implied value</span><b>${money(r.implied_value_usd)}</b></div>
      <div class="kv"><span>TVL</span><b>${money(r.tvl_usd)}</b></div>
      <div class="kv"><span>Peer multiple</span><b>${r.peer_multiple.toFixed(4)}</b></div>
      <div class="kv"><span>Peer median ratio</span><b>${r.peer_median.toFixed(4)}</b></div>
      <div class="kv"><span>Growth factor</span><b>${r.growth_mult.toFixed(3)}</b></div>
      <div class="kv"><span>Maturity factor</span><b>${r.maturity_mult.toFixed(3)}</b></div>
      <div class="kv"><span>Breadth factor</span><b>${r.breadth_mult.toFixed(3)}</b></div>
      <div class="kv"><span>Age / chains</span><b>${r.age_days}d · ${r.chains.length}</b></div>
    </div>
    <div class="recompute">Recompute: ${compact(r.tvl_usd)} × ${r.peer_multiple.toFixed(4)} × ${r.growth_mult.toFixed(3)} × ${r.maturity_mult.toFixed(3)} × ${r.breadth_mult.toFixed(3)} = <b>${money(recomputed)}</b> ${recomputed === r.implied_value_usd ? '✓ matches board' : '≠ board'}</div>
    <h3>Sensitivity range</h3>
    <div class="rangebar"><i style="left:${Math.min(98, Math.max(1, logPos))}%"></i></div>
    <p class="muted">${money(r.value_low)} low · ${money(r.implied_value_usd)} base · ${money(r.value_high)} high. The range uses winsorized peer-ratio quartiles, shrunk the same way as the multiple.</p>
    <h3>Risk flags</h3>${flags}
    <h3>Farm plan</h3>
    <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
}

function renderModel() {
  const b = R.meta.loo.baseline;
  const r = R.meta.loo.robust;
  $('loo').innerHTML = [
    ['Peer set', `${R.meta.peer_count} live peers`],
    ['Global median ratio', R.meta.global_median.toFixed(4)],
    ['LOO median |log err|', `${b.median_abs_log_err.toFixed(4)} → ${r.median_abs_log_err.toFixed(4)}`],
    ['LOO median implied/actual', `${b.median_ratio.toFixed(4)} → ${r.median_ratio.toFixed(4)}`],
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('');
  $('peers').innerHTML = `<thead><tr><th>Category</th><th class="num">Peer n</th><th class="num">Winsorized median</th><th class="num">Multiple used</th><th>Confidence</th></tr></thead><tbody>${R.peers.map((p) => `<tr><td>${esc(p.category)}</td><td class="num">${p.peer_n}</td><td class="num">${p.median_ratio.toFixed(4)}</td><td class="num">${p.multiple.toFixed(4)}</td><td><span class="badge ${esc(p.confidence)}">${esc(p.confidence)}</span></td></tr>`).join('')}</tbody>`;
}

function initControls() {
  $('search').value = state.q;
  $('category').innerHTML = '<option value="all">All categories</option>' + R.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('category').value = R.categories.includes(state.cat) ? state.cat : 'all';
  state.cat = $('category').value;
  $('mode-pre').classList.toggle('active', state.mode === 'pre');
  $('mode-live').classList.toggle('active', state.mode === 'live');
  $('search').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('category').addEventListener('change', (e) => { state.cat = e.target.value; renderTable(); });
  $('mode-pre').addEventListener('click', () => { state.mode = 'pre'; state.selected = rows[0].slug; initControls(); renderTable(); renderDetail(); });
  $('mode-live').addEventListener('click', () => { state.mode = 'live'; state.selected = liveRows[0].slug; initControls(); renderTable(); renderDetail(); });
}

renderStats();
renderDeciles();
initControls();
renderTable();
renderDetail();
renderModel();
const shot = params.get('shot') || (params.get('view') === 'model' ? 'model' : '');
if (shot) document.body.classList.add(`shot-${shot}`);
