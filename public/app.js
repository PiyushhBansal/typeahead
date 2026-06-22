const $ = (id) => document.getElementById(id);
const input = $('q');
const list = $('suggestions');
const clearBtn = $('clear');
const meta = $('meta');

let mode = 'recency';
let items = [];
let active = -1;
let lastReq = 0;

const DEBOUNCE_MS = 120;
let debounceTimer = null;

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  clearBtn.hidden = input.value.length === 0;
  if (items.length === 0) {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  const prefix = input.value.trim().toLowerCase();
  list.innerHTML = items
    .map((it, i) => {
      const q = escapeHtml(it.query);
      const hl =
        prefix && it.query.toLowerCase().startsWith(prefix)
          ? `<span class="hl">${escapeHtml(it.query.slice(0, prefix.length))}</span>${escapeHtml(it.query.slice(prefix.length))}`
          : q;
      return `<li role="option" data-i="${i}" aria-selected="${i === active}">
        <span class="s-rank">${i + 1}</span>
        <span class="s-text">${hl}</span>
        <span class="s-count">${it.count.toLocaleString()}</span>
      </li>`;
    })
    .join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

async function fetchSuggestions() {
  const q = input.value.trim();
  if (!q) {
    items = [];
    active = -1;
    meta.textContent = '';
    render();
    return;
  }
  const seq = ++lastReq;
  try {
    const r = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${mode}`);
    const data = await r.json();
    if (seq !== lastReq) return;
    items = data.suggestions || [];
    active = -1;
    meta.innerHTML = `${data.latencyMs.toFixed(2)}ms <span class="badge ${data.source === 'cache' ? 'hit' : 'miss'}">${data.source}</span> ${data.node || '-'}`;
    $('m-node').textContent = data.node || '-';
    render();
  } catch (e) {
    setConn(false);
  }
}

function onInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fetchSuggestions, DEBOUNCE_MS);
}

async function submitSearch(query) {
  const q = (query !== undefined ? query : input.value).trim();
  if (!q) return;
  input.value = q;
  try {
    const r = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await r.json();
    $('result-body').textContent = JSON.stringify(data);
    $('result').hidden = false;
    items = [];
    render();
    refreshTrending();
    refreshStats();
  } catch (e) {
    setConn(false);
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault();
    active = (active + 1) % items.length;
    render();
  } else if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault();
    active = (active - 1 + items.length) % items.length;
    render();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (active >= 0 && items[active]) submitSearch(items[active].query);
    else submitSearch();
  } else if (e.key === 'Escape') {
    items = [];
    render();
  }
});

list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  submitSearch(items[Number(li.dataset.i)].query);
});

input.addEventListener('input', onInput);
$('go').addEventListener('click', () => submitSearch());
clearBtn.addEventListener('click', () => {
  input.value = '';
  items = [];
  render();
  input.focus();
});

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    mode = btn.dataset.mode;
    fetchSuggestions();
  });
});

async function refreshTrending() {
  try {
    const r = await fetch('/trending?limit=10');
    const { trending } = await r.json();
    const el = $('trending');
    if (!trending.length) {
      el.innerHTML = '<li class="empty">No recent searches yet. Submit a few searches.</li>';
      return;
    }
    el.innerHTML = trending
      .map(
        (t) =>
          `<li data-q="${encodeURIComponent(t.query)}"><span class="t-q">${escapeHtml(t.query)}</span><span class="t-v">${t.recent}</span></li>`
      )
      .join('');
    el.querySelectorAll('li[data-q]').forEach((li) =>
      li.addEventListener('click', () => {
        input.value = decodeURIComponent(li.dataset.q);
        fetchSuggestions();
        input.focus();
      })
    );
  } catch (e) {
    setConn(false);
  }
}

async function refreshStats() {
  try {
    const r = await fetch('/stats');
    const s = await r.json();
    setConn(true);
    $('m-hit').textContent = `${(s.cache.hitRate * 100).toFixed(1)}%`;
    $('m-p95').textContent = `${s.latency.p95} ms`;
    $('m-rw').textContent = `${s.store.reads.toLocaleString()} / ${s.store.writes.toLocaleString()}`;
    $('m-wr').textContent = `${(s.batch.writeReduction * 100).toFixed(1)}%`;
    $('m-nodes').textContent = s.cache.nodeCount;
  } catch (e) {
    setConn(false);
  }
}

function setConn(ok) {
  $('conn').classList.toggle('ok', ok);
  $('conn-text').textContent = ok ? 'connected' : 'disconnected';
}

refreshTrending();
refreshStats();
setInterval(refreshTrending, 4000);
setInterval(refreshStats, 3000);
input.focus();
