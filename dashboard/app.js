const DATA = window.RADAR;
const BOARD_ROWS = DATA.rows;
const LIVE_ROWS = DATA.live_rows;

const params = new URLSearchParams(window.location.search);
const state = {
  query: '',
  category: params.get('category') || '',
  status: params.get('status') === 'live' ? 'live' : 'pre',
  sortKey: 'rank',
  sortDir: 1,
  selectedSlug: params.get('slug') || '',
};

const els = {
  snapshotLine: document.querySelector('#snapshot-line'),
  heroCount: document.querySelector('#hero-count'),
  stats: document.querySelector('#stats'),
  deciles: document.querySelector('#deciles'),
  distributionTotal: document.querySelector('#distribution-total'),
  search: document.querySelector('#search'),
  category: document.querySelector('#category'),
  statusPre: document.querySelector('#status-pre'),
  statusLive: document.querySelector('#status-live'),
  rowCount: document.querySelector('#row-count'),
  boardTitle: document.querySelector('#board-title'),
  boardSubtitle: document.querySelector('#board-subtitle'),
  valueHeading: document.querySelector('#value-heading'),
  rows: document.querySelector('#rows'),
  empty: document.querySelector('#empty'),
  detail: document.querySelector('#detail'),
  detailContent: document.querySelector('#detail-content'),
  detailClose: document.querySelector('#detail-close'),
  scrim: document.querySelector('#scrim'),
  modelKpis: document.querySelector('#model-kpis'),
  modelFormula: document.querySelector('#model-formula'),
  backtestNotes: document.querySelector('#backtest-notes'),
  peerRows: document.querySelector('#peer-rows'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function money(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

function moneyFull(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function percent(value) {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(2)}%`;
}

function ageLabel(days) {
  return days < 365 ? `${days}d` : `${(days / 365).toFixed(1)}y`;
}

function categoryOf(row) {
  return row.category ?? 'Uncategorised';
}

function chainLabel(row, full = false) {
  const chains = row.chains ?? [];
  if (chains.length === 0) return 'chain not recorded';
  if (full) return chains.join(', ');
  const shown = chains.slice(0, 2).join(', ');
  return chains.length > 2 ? `${shown} +${chains.length - 2}` : shown;
}

function rowValue(row) {
  return state.status === 'live' ? row.market_cap_usd : row.implied_value_usd;
}

function recompute(row) {
  return Math.round(row.tvl_usd * row.peer_multiple * row.growth_multiplier * row.maturity_multiplier * row.breadth_multiplier);
}

function renderStats() {
  const meta = DATA.meta;
  els.snapshotLine.textContent = `Snapshot ${meta.as_of} · DefiLlama protocol index · radar-2 calibrated · peer median ${DATA.model.global_median.toFixed(4)}`;
  els.heroCount.textContent = meta.board_count;
  const cards = [
    ['Watchlist covered', `${meta.watchlist_count} / ${meta.watchlist_count}`],
    ['Pre-token rows scored', meta.board_count],
    ['Early rows below floor', meta.early_count],
    ['Live-token set aside', meta.live_count],
  ];
  els.stats.innerHTML = cards.map(([label, value]) => `
    <div class="stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>
  `).join('');
}

function renderDeciles() {
  const sorted = [...BOARD_ROWS].sort((a, b) => a.rank - b.rank);
  const groups = [];
  for (let i = 0; i < 10; i += 1) {
    const start = i * 23;
    const slice = sorted.slice(start, i === 9 ? sorted.length : start + 23);
    if (slice.length === 0) continue;
    groups.push({
      label: `Ranks ${slice[0].rank}–${slice[slice.length - 1].rank}`,
      total: slice.reduce((sum, row) => sum + row.implied_value_usd, 0),
    });
  }
  const logs = groups.map((g) => Math.log10(Math.max(g.total, 1)));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  els.distributionTotal.textContent = money(total);
  els.deciles.innerHTML = groups.map((group, index) => {
    const width = max === min ? 100 : 8 + ((logs[index] - min) / (max - min)) * 92;
    return `
      <div class="decile">
        <span class="decile-label">${escapeHtml(group.label)}</span>
        <span class="decile-track"><span class="decile-fill" style="width:${width.toFixed(1)}%"></span></span>
        <span class="decile-value">${money(group.total)}</span>
      </div>`;
  }).join('');
}

function currentRows() {
  const source = state.status === 'live' ? LIVE_ROWS : BOARD_ROWS;
  const query = state.query.trim().toLowerCase();
  const filtered = source.filter((row) => {
    if (state.category && categoryOf(row) !== state.category) return false;
    if (!query) return true;
    const haystack = `${row.name} ${categoryOf(row)} ${(row.chains ?? []).join(' ')}`.toLowerCase();
    return haystack.includes(query);
  });
  const sorted = [...filtered].sort((a, b) => {
    let result = 0;
    switch (state.sortKey) {
      case 'name': result = a.name.localeCompare(b.name); break;
      case 'tvl': result = a.tvl_usd - b.tvl_usd; break;
      case 'change': result = (a.change_7d ?? -Infinity) - (b.change_7d ?? -Infinity); break;
      case 'age': result = a.age_days - b.age_days; break;
      case 'value': result = rowValue(a) - rowValue(b); break;
      case 'token': result = state.status.localeCompare(state.status); break;
      default: result = a.rank - b.rank;
    }
    return result === 0 ? a.rank - b.rank : result * state.sortDir;
  });
  return sorted;
}

function renderSortMarks() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    const mark = th.querySelector('.sort-mark');
    const active = th.dataset.sort === state.sortKey;
    th.setAttribute('aria-sort', active ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none');
    mark.textContent = active ? (state.sortDir === 1 ? '▲' : '▼') : '↕';
  });
}

function renderRows() {
  const rows = currentRows();
  const maxValue = Math.max(...rows.map(rowValue), 1);
  els.rowCount.textContent = `${rows.length} rows shown`;
  els.boardTitle.textContent = state.status === 'live' ? 'Live-token protocols set aside' : 'Pre-token board';
  els.boardSubtitle.textContent = state.status === 'live'
    ? 'Tokens that already trade, shown with the model estimate beside the recorded market cap.'
    : 'Strongest implied value first. Select a row for its model and farm plan.';
  els.valueHeading.firstChild.textContent = state.status === 'live' ? 'Market cap ' : 'Implied value ';
  els.empty.hidden = rows.length > 0;
  els.rows.innerHTML = rows.map((row) => {
    const value = rowValue(row);
    const width = Math.max(2, (value / maxValue) * 100);
    const changeClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'positive' : 'negative';
    const selected = row.slug === state.selectedSlug ? ' selected' : '';
    const token = state.status === 'live'
      ? '<span class="token-dot live"></span>live'
      : '<span class="token-dot"></span>no token';
    return `
      <tr class="${selected}" tabindex="0" data-slug="${escapeHtml(row.slug)}">
        <td class="rank">${row.rank}</td>
        <td class="protocol"><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(categoryOf(row))} on ${escapeHtml(chainLabel(row))}</span></td>
        <td class="number">${money(row.tvl_usd)}</td>
        <td class="number ${changeClass}">${percent(row.change_7d)}</td>
        <td class="number">${ageLabel(row.age_days)}</td>
        <td class="value-cell"><span class="value-bar"><span class="value-fill" style="width:${width.toFixed(1)}%"></span></span><span class="value-amount">${money(value)}</span></td>
        <td>${token}</td>
      </tr>`;
  }).join('');
  renderSortMarks();
}

function breakdownRows(row, live) {
  const estimate = recompute(row);
  const lines = [
    ['TVL', moneyFull(row.tvl_usd)],
    [`Peer multiple (${categoryOf(row)})`, row.peer_multiple.toFixed(4)],
    ['Seven-day growth', percent(row.change_7d)],
    [live ? 'Age on record' : 'Age with no token', ageLabel(row.age_days)],
    ['Growth multiplier', row.growth_multiplier.toFixed(4)],
    ['Maturity multiplier', row.maturity_multiplier.toFixed(4)],
    [`Breadth multiplier (${(row.chains ?? []).length} chains)`, row.breadth_multiplier.toFixed(2)],
  ];
  if (live) {
    lines.push(['Recorded market cap', moneyFull(row.market_cap_usd)]);
    lines.push(['Model estimate', moneyFull(estimate)]);
    lines.push(['Estimate / market cap', `${row.model_ratio.toFixed(2)}x`]);
  } else {
    lines.push(['Implied value', moneyFull(row.implied_value_usd)]);
  }
  return lines.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function farmPlan(row) {
  return `<ol class="farm">${row.farm_steps.map((step) => {
    const at = step.indexOf(' Cost:');
    const main = at >= 0 ? step.slice(0, at + 1) : step;
    const cost = at >= 0 ? step.slice(at + 1) : '';
    return `<li><p>${escapeHtml(main)}${cost ? `<span class="cost">${escapeHtml(cost)}</span>` : ''}</p></li>`;
  }).join('')}</ol>`;
}

function renderDetail(row) {
  const live = state.status === 'live';
  const estimate = recompute(row);
  const recomputeLine = live
    ? `The same function scores every protocol. It estimates ${moneyFull(estimate)} here, against a recorded market cap of ${moneyFull(row.market_cap_usd)}.`
    : estimate === row.implied_value_usd
      ? `Model radar-2 calibrated: this page recomputes this row as ${moneyFull(estimate)} — the same number board.json carries. This is an estimate, not a price.`
      : `Model radar-2 calibrated: this page recomputes this row as ${moneyFull(estimate)}; board.json carries ${moneyFull(row.implied_value_usd)}. This is an estimate, not a price.`;
  els.detailContent.innerHTML = `
    <div class="detail-kicker">Rank ${row.rank} of ${live ? LIVE_ROWS.length : BOARD_ROWS.length}</div>
    <h2>${escapeHtml(row.name)}</h2>
    <p class="detail-subtitle">${escapeHtml(categoryOf(row))} on ${escapeHtml(chainLabel(row, true))}</p>
    <h3>${live ? 'Recorded value' : 'Implied value'}</h3>
    <div class="breakdown">${breakdownRows(row, live)}</div>
    <p class="recompute">${escapeHtml(recomputeLine)}</p>
    ${live
      ? '<h3>Token status</h3><p class="recompute">This protocol already records a live token, so the radar sets it aside instead of ranking it as a launch candidate.</p>'
      : `<h3>Farm plan</h3>${farmPlan(row)}`}
  `;
}

function openDetail(slug) {
  const source = state.status === 'live' ? LIVE_ROWS : BOARD_ROWS;
  const row = source.find((item) => item.slug === slug);
  if (!row) return;
  state.selectedSlug = slug;
  renderDetail(row);
  els.detail.hidden = false;
  els.scrim.hidden = false;
  renderRows();
}

function closeDetail() {
  state.selectedSlug = '';
  els.detail.hidden = true;
  els.scrim.hidden = true;
  renderRows();
}

function renderModelCheck() {
  const model = DATA.model;
  const check = DATA.backtest;
  const typicalFactor = Math.exp(check.median_abs_log_error);
  els.modelKpis.innerHTML = [
    ['LOO peers', check.peer_count],
    ['Median estimate / actual', `${check.median_ratio.toFixed(2)}x`],
    ['Median log error', check.median_abs_log_error.toFixed(2)],
    ['Typical factor', `${typicalFactor.toFixed(1)}x`],
  ].map(([label, value]) => `<span class="kpi">${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`).join('');

  els.modelFormula.innerHTML = `
    <p><strong>Implied value = TVL × peer multiple × growth × maturity × breadth.</strong></p>
    <p>Peer multiple: category median market-cap-to-TVL, shrunk toward the global median ${model.global_median.toFixed(4)} with k=${model.shrinkage_k}, clamped ${model.multiple_min.toFixed(2)}–${model.multiple_max.toFixed(2)}. Peers are live-token protocols with TVL at most ${money(model.peer_tvl_cap_usd)}.</p>
    <p>Growth uses the seven-day TVL change at weight ${model.growth_weight}. Maturity rises from ${model.maturity_floor} to 1 over ${model.maturity_cap_days} days. Breadth adds ${model.breadth_per_chain} per extra chain, capped at ${model.breadth_cap} extra chains.</p>
  `;

  const bias = check.category_bias.map((item) => `${item.category} ${item.median_ratio.toFixed(2)}x`).join(' · ');
  els.backtestNotes.innerHTML = `
    <p>Calibration moved the leave-one-out median log error from <strong>${check.baseline_median_abs_log_error.toFixed(2)}</strong> to <strong>${check.median_abs_log_error.toFixed(2)}</strong>, with the median estimate at <strong>${check.median_ratio.toFixed(2)}x</strong> of recorded market cap.</p>
    <p>Largest remaining category biases: ${escapeHtml(bias)}. Dead tokens and businesses whose market cap is disconnected from TVL dominate the error, so the check is a calibration guardrail, not a promise.</p>
  `;

  els.peerRows.innerHTML = DATA.category_stats.map((item) => `
    <tr>
      <td>${escapeHtml(item.category)}</td>
      <td>${item.live_peers}</td>
      <td>${item.raw_median === null ? '—' : item.raw_median.toFixed(3)}</td>
      <td>${item.multiple.toFixed(3)}</td>
      <td>${item.board_rows}</td>
    </tr>
  `).join('');
}

function renderCategories() {
  const categories = [...new Set([...BOARD_ROWS, ...LIVE_ROWS].map(categoryOf))].sort((a, b) => a.localeCompare(b));
  els.category.innerHTML = '<option value="">All categories</option>' + categories.map((category) => (
    `<option value="${escapeHtml(category)}" ${category === state.category ? 'selected' : ''}>${escapeHtml(category)}</option>`
  )).join('');
}

function setStatus(status) {
  state.status = status;
  state.selectedSlug = '';
  els.statusPre.classList.toggle('active', status === 'pre');
  els.statusLive.classList.toggle('active', status === 'live');
  closeDetail();
  renderRows();
}

function init() {
  renderStats();
  renderDeciles();
  renderCategories();
  els.search.value = state.query;
  els.category.value = state.category;
  els.statusPre.classList.toggle('active', state.status === 'pre');
  els.statusLive.classList.toggle('active', state.status === 'live');
  renderRows();
  renderModelCheck();

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderRows();
  });
  els.category.addEventListener('change', () => {
    state.category = els.category.value;
    renderRows();
  });
  els.statusPre.addEventListener('click', () => setStatus('pre'));
  els.statusLive.addEventListener('click', () => setStatus('live'));
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.querySelector('button').addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir *= -1;
      } else {
        state.sortKey = key;
        state.sortDir = key === 'rank' || key === 'name' || key === 'token' ? 1 : -1;
      }
      renderRows();
    });
  });
  els.rows.addEventListener('click', (event) => {
    const tr = event.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  els.rows.addEventListener('keydown', (event) => {
    const tr = event.target.closest('tr[data-slug]');
    if (tr && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openDetail(tr.dataset.slug);
    }
  });
  els.detailClose.addEventListener('click', closeDetail);
  els.scrim.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.detail.hidden) closeDetail();
  });

  if (state.selectedSlug) openDetail(state.selectedSlug);
  if (params.get('view') === 'model') {
    document.body.classList.add('model-focus');
  }
}

init();
