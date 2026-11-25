// app.js — Token Radar dashboard. Reads window.RADAR (board.json as data.js),
// renders the board, and recomputes each row's implied value from the board's
// own multipliers so the page can be checked against board.json. No network:
// the data arrives in data.js, the page never fetches anything.
(function () {
  var D = window.RADAR;
  if (!D || !Array.isArray(D.rows)) {
    document.body.textContent = 'No radar data.';
    return;
  }

  var rows = D.rows;
  var liveRows = D.live || [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtUsd(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return '—';
    if (d < 365) return d + 'd';
    return (d / 365).toFixed(1) + 'y';
  }
  function fmtPct(v) {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }
  // The model's own arithmetic, from the row's stored multipliers.
  function recompute(r) {
    return Math.round(r.tvl_usd * r.peer_multiple * r.growth_multiplier * r.maturity_multiplier * r.breadth_multiplier);
  }

  // ---- state -------------------------------------------------------------
  var state = { q: '', cat: 'All categories', status: 'pre', sort: 'rank', dir: 1, selected: null };
  var params = new URLSearchParams(window.location.search);
  if (params.get('category')) state.cat = params.get('category');
  if (params.get('status') === 'live') state.status = 'live';

  // ---- header, stats, distribution ---------------------------------------
  $('topMeta').textContent = 'Snapshot ' + D.as_of + ' · radar-2 model · peer median ' + D.peers.global.toFixed(4);
  $('heroCount').textContent = String(D.board_size);
  $('asOf').textContent = D.as_of;

  var stats = [
    ['Watchlist covered', D.watchlist_size + ' / 40', ''],
    ['Pre-token rows scored', String(D.board_size), ''],
    ['Early rows below floor', String(D.early_size), ''],
    ['Live-token set aside', String(D.live_size), ''],
  ];
  $('stats').innerHTML = stats.map(function (s) {
    return '<div class="stat"><div class="k">' + s[0] + '</div><div class="v">' + s[1] + '</div></div>';
  }).join('');

  // Implied value by rank decile, log-scaled so the tail stays visible.
  (function renderDeciles() {
    var sorted = rows.slice().sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; });
    var per = Math.ceil(sorted.length / 10);
    var groups = [];
    var maxSum = 0;
    for (var i = 0; i < 10; i++) {
      var g = sorted.slice(i * per, (i + 1) * per);
      if (!g.length) break;
      var sum = g.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
      if (sum > maxSum) maxSum = sum;
      groups.push({ from: i * per + 1, to: Math.min((i + 1) * per, sorted.length), sum: sum });
    }
    $('deciles').innerHTML = groups.map(function (g, i) {
      var w = Math.max(2, Math.round((100 * Math.log10(g.sum + 1)) / Math.log10(maxSum + 1)));
      return '<div class="decile"><span class="dl">Ranks ' + g.from + '–' + g.to + '</span>' +
        '<span class="track"><span class="fill' + (i === 0 ? ' top' : '') + '" style="display:block;width:' + w + '%"></span></span>' +
        '<span class="dv">' + fmtUsd(g.sum) + '</span></div>';
    }).join('');
  })();

  // ---- category filter ----------------------------------------------------
  var cats = [];
  rows.forEach(function (r) { if (cats.indexOf(r.category) === -1) cats.push(r.category); });
  cats.sort();
  $('cat').innerHTML = '<option>All categories</option>' + cats.map(function (c) {
    return '<option' + (c === state.cat ? ' selected' : '') + '>' + esc(c) + '</option>';
  }).join('');

  // ---- table --------------------------------------------------------------
  var COLS = [
    { key: 'rank', label: 'Rank', num: true },
    { key: 'name', label: 'Protocol', num: false },
    { key: 'tvl_usd', label: 'TVL', num: true },
    { key: 'change_7d', label: '7d', num: true },
    { key: 'age_days', label: 'Age', num: true },
    { key: 'value', label: 'Implied value', num: true },
    { key: 'token', label: 'Token', num: false },
  ];

  function viewRows() {
    var base = state.status === 'live'
      ? liveRows.map(function (r, i) {
          return {
            rank: i + 1, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
            tvl_usd: r.tvl_usd, change_7d: r.change_7d, age_days: null,
            implied_value_usd: r.mcap_usd, mcap_usd: r.mcap_usd, isLive: true, farm_steps: null,
          };
        })
      : rows;
    var q = state.q.trim().toLowerCase();
    var out = base.filter(function (r) {
      if (state.cat !== 'All categories' && r.category !== state.cat) return false;
      if (!q) return true;
      var hay = (r.name + ' ' + r.category + ' ' + (r.chains || []).join(' ')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var key = state.sort;
    var dir = state.dir;
    out.sort(function (a, b) {
      var av, bv;
      if (key === 'value') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else if (key === 'token') { av = a.isLive ? 1 : 0; bv = b.isLive ? 1 : 0; }
      else if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else { av = a[key]; bv = b[key]; }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return (a.rank - b.rank) * 1;
    });
    return out;
  }

  function renderHead() {
    var valueLabel = state.status === 'live' ? 'Market cap' : 'Implied value';
    $('headRow').innerHTML = COLS.map(function (c) {
      var label = c.key === 'value' ? valueLabel : c.label;
      var active = state.sort === c.key;
      var ind = active ? (state.dir === 1 ? '▲' : '▼') : '↕';
      return '<th class="' + (c.num ? 'num' : '') + '"><button type="button" class="sort' + (active ? ' active' : '') +
        '" data-sort="' + c.key + '">' + label + '<span class="ind">' + ind + '</span></button></th>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('button.sort'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
        renderTable();
      });
    });
  }

  function renderTable() {
    renderHead();
    var list = viewRows();
    var maxVal = 0;
    list.forEach(function (r) { if (r.implied_value_usd > maxVal) maxVal = r.implied_value_usd; });
    $('body').innerHTML = list.map(function (r) {
      var chains = (r.chains || []).slice(0, 2).join(', ');
      if ((r.chains || []).length > 2) chains += ' +' + ((r.chains || []).length - 2);
      var pct = r.change_7d;
      var pctCls = pct >= 0 ? 'up' : 'down';
      var barW = maxVal ? Math.max(2, Math.round((100 * r.implied_value_usd) / maxVal)) : 0;
      var tok = r.isLive
        ? '<span class="tok live"><i></i>live</span>'
        : '<span class="tok"><i></i>no token</span>';
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><div class="name">' + esc(r.name) + '</div><div class="sub">' + esc(r.category) + ' on ' + esc(chains) + '</div></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num"><span class="' + pctCls + '">' + fmtPct(pct) + '</span></td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><span class="vbar"><span class="track"><span class="fill" style="display:block;width:' + barW + '%"></span></span><span class="val">' + fmtUsd(r.implied_value_usd) + '</span></span></td>' +
        '<td>' + tok + '</td></tr>';
    }).join('');
    $('shown').textContent = list.length + ' rows shown';
    $('tableHint').textContent = state.status === 'live'
      ? 'Live-token protocols, largest market cap first. Select a row for its market cap and TVL.'
      : 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.';
    Array.prototype.forEach.call(document.querySelectorAll('#body tr'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }

  // ---- detail panel -------------------------------------------------------
  function openDetail(slug) {
    var r = null;
    var i;
    for (i = 0; i < rows.length; i++) if (rows[i].slug === slug) { r = rows[i]; break; }
    var isLive = false;
    if (!r) {
      for (i = 0; i < liveRows.length; i++) {
        if (liveRows[i].slug === slug) {
          var l = liveRows[i];
          r = {
            rank: i + 1, slug: l.slug, name: l.name, category: l.category, chains: l.chains,
            tvl_usd: l.tvl_usd, change_7d: l.change_7d, age_days: null,
            implied_value_usd: l.mcap_usd, mcap_usd: l.mcap_usd, isLive: true, farm_steps: null,
          };
          isLive = true;
          break;
        }
      }
    }
    if (!r) return;
    state.selected = slug;
    renderTable();
    var chains = (r.chains || []).join(', ');
    var html = '<div class="rankline">Rank ' + r.rank + ' of ' + (isLive ? liveRows.length : rows.length) + '</div>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="catline">' + esc(r.category) + ' on ' + esc(chains) + '</div>';
    if (isLive) {
      html += '<h3>Market cap</h3>' +
        '<div class="kv"><span>Market cap</span><span>' + fmtUsd(r.mcap_usd) + '</span></div>' +
        '<div class="kv"><span>TVL</span><span>' + fmtUsd(r.tvl_usd) + '</span></div>' +
        '<div class="kv"><span>Seven-day change</span><span>' + fmtPct(r.change_7d) + '</span></div>' +
        '<p class="note">Token already trading — set aside, not ranked. The board only ranks protocols with no token on record.</p>';
    } else {
      var again = recompute(r);
      html += '<h3>Implied value</h3>' +
        '<div class="kv"><span>TVL</span><span>' + fmtUsd(r.tvl_usd) + '</span></div>' +
        '<div class="kv"><span>Peer multiple (' + esc(r.category) + ')</span><span>' + r.peer_multiple.toFixed(4) + '</span></div>' +
        '<div class="kv"><span>Seven-day growth</span><span>' + fmtPct(r.change_7d) + '</span></div>' +
        '<div class="kv"><span>Age with no token</span><span>' + fmtAge(r.age_days) + '</span></div>' +
        '<div class="kv"><span>Growth multiplier</span><span>' + r.growth_multiplier.toFixed(4) + '</span></div>' +
        '<div class="kv"><span>Maturity multiplier</span><span>' + r.maturity_multiplier.toFixed(4) + '</span></div>' +
        '<div class="kv"><span>Breadth multiplier (' + (r.chains || []).length + ' chains)</span><span>' + r.breadth_multiplier.toFixed(2) + '</span></div>' +
        '<div class="kv total"><span>Implied value</span><span>' + fmtUsd(r.implied_value_usd) + '</span></div>' +
        '<p class="recompute">Model radar-2: the same function scores every protocol. This page recomputes this row as ' +
        fmtUsd(again) + ' — the same number board.json carries. This is an estimate, not a price.</p>' +
        '<h3>Farm plan</h3><ol class="farm">' +
        (r.farm_steps || []).map(function (s) {
          var cut = s.indexOf(' Cost: ');
          var text = cut === -1 ? s : s.slice(0, cut);
          var cost = cut === -1 ? '' : s.slice(cut + 1);
          return '<li>' + esc(text) + (cost ? '<div class="cost">' + esc(cost) + '</div>' : '') + '</li>';
        }).join('') + '</ol>';
    }
    $('detailBody').innerHTML = html;
    $('detail').hidden = false;
  }

  function closeDetail() {
    $('detail').hidden = true;
    state.selected = null;
    renderTable();
  }
  $('closeDetail').addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  // ---- controls -----------------------------------------------------------
  $('q').addEventListener('input', function () { state.q = $('q').value; renderTable(); });
  $('cat').addEventListener('change', function () { state.cat = $('cat').value; renderTable(); });
  Array.prototype.forEach.call(document.querySelectorAll('#statusSeg button'), function (b) {
    b.addEventListener('click', function () {
      state.status = b.getAttribute('data-status');
      state.sort = 'rank';
      state.dir = 1;
      Array.prototype.forEach.call(document.querySelectorAll('#statusSeg button'), function (x) {
        x.classList.toggle('on', x === b);
      });
      renderTable();
    });
  });
  if (state.status === 'live') {
    Array.prototype.forEach.call(document.querySelectorAll('#statusSeg button'), function (x) {
      x.classList.toggle('on', x.getAttribute('data-status') === 'live');
    });
  }
  if (state.cat !== 'All categories') $('cat').value = state.cat;

  renderTable();
  if (params.get('slug')) openDetail(params.get('slug'));
})();
