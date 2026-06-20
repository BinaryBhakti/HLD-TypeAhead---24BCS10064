'use strict';

// Frontend for the typeahead. Plain JS, no framework. The two things worth
// pointing out: input is debounced so we don't fire a request per keystroke, and
// the dropdown is keyboard-navigable (Up/Down/Enter/Escape).

const $q = document.getElementById('q');
const $go = document.getElementById('go');
const $list = document.getElementById('suggestions');
const $status = document.getElementById('status');
const $result = document.getElementById('result');
const $resultBody = document.getElementById('result-body');
const $trending = document.getElementById('trending-list');

const DEBOUNCE_MS = 120;
let debounceTimer = null;
let activeIndex = -1; // highlighted suggestion, -1 = none
let current = []; // current suggestion objects
let lastReqId = 0; // guards against out-of-order responses

function setStatus(msg, isError = false) {
  $status.textContent = msg || '';
  $status.classList.toggle('error', !!isError);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Bold the part of the suggestion that matches what was typed.
function renderLabel(query, prefix) {
  const safe = escapeHtml(query);
  if (prefix && query.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<span class="match">${escapeHtml(query.slice(0, prefix.length))}</span>${escapeHtml(query.slice(prefix.length))}`;
  }
  return safe;
}

function closeList() {
  $list.hidden = true;
  $q.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}

function renderSuggestions(items, prefix) {
  current = items;
  activeIndex = -1;
  if (!items.length) {
    closeList();
    return;
  }
  $list.innerHTML = items
    .map(
      (s, i) =>
        `<li role="option" data-i="${i}" aria-selected="false">` +
        `<span>${renderLabel(s.query, prefix)}</span>` +
        `<span class="count">${s.count != null ? s.count.toLocaleString() : ''}</span>` +
        `</li>`
    )
    .join('');
  $list.hidden = false;
  $q.setAttribute('aria-expanded', 'true');
}

function highlight(next) {
  const lis = $list.querySelectorAll('li');
  if (!lis.length) return;
  if (activeIndex >= 0) lis[activeIndex].setAttribute('aria-selected', 'false');
  activeIndex = (next + lis.length) % lis.length;
  const li = lis[activeIndex];
  li.setAttribute('aria-selected', 'true');
  li.scrollIntoView({ block: 'nearest' });
}

async function fetchSuggestions(prefix) {
  const reqId = ++lastReqId;
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(prefix)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (reqId !== lastReqId) return; // a newer keystroke already won
    renderSuggestions(data.suggestions || [], prefix);
    setStatus(data.suggestions.length ? '' : 'No matches');
  } catch (err) {
    if (reqId !== lastReqId) return;
    setStatus('Could not load suggestions', true);
    closeList();
  }
}

function onInput() {
  const prefix = $q.value.trim();
  clearTimeout(debounceTimer);
  if (!prefix) {
    closeList();
    setStatus('');
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(prefix), DEBOUNCE_MS);
}

async function submitSearch(query) {
  const q = (query || $q.value).trim();
  if (!q) return;
  $q.value = q;
  closeList();
  setStatus('Searching...');
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    $resultBody.textContent = JSON.stringify(data);
    $result.hidden = false;
    setStatus('');
    // Recently searched terms should surface in trending shortly after the next flush.
    setTimeout(loadTrending, 400);
  } catch (err) {
    setStatus('Search failed', true);
  }
}

function onKeyDown(e) {
  const open = !$list.hidden;
  switch (e.key) {
    case 'ArrowDown':
      if (open) { e.preventDefault(); highlight(activeIndex + 1); }
      break;
    case 'ArrowUp':
      if (open) { e.preventDefault(); highlight(activeIndex - 1); }
      break;
    case 'Enter':
      if (open && activeIndex >= 0) {
        e.preventDefault();
        submitSearch(current[activeIndex].query);
      } else {
        submitSearch();
      }
      break;
    case 'Escape':
      closeList();
      break;
  }
}

async function loadTrending() {
  try {
    const res = await fetch('/trending');
    const data = await res.json();
    $trending.innerHTML = (data.trending || [])
      .map(
        (t) =>
          `<li data-q="${escapeHtml(t.query)}">${escapeHtml(t.query)}` +
          `<span class="count">${(t.count || 0).toLocaleString()}</span></li>`
      )
      .join('');
  } catch (err) {
    /* trending is non-critical; leave the panel as-is */
  }
}

// events
$q.addEventListener('input', onInput);
$q.addEventListener('keydown', onKeyDown);
$q.addEventListener('focus', () => { if ($q.value.trim()) onInput(); });
$go.addEventListener('click', () => submitSearch());

$list.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (li) submitSearch(current[Number(li.dataset.i)].query);
});

$trending.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) submitSearch(li.dataset.q);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.combo')) closeList();
});

loadTrending();
