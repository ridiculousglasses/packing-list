// ─── Notion API ───────────────────────────────────────────────────────────────
const NOTION_VERSION = '2022-06-28';

async function notionFetch(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Notion API error ${res.status}`);
  }
  return res.json();
}

async function queryDatabase(dbId, filter = null, sorts = null) {
  const body = {};
  if (filter) body.filter = filter;
  if (sorts)  body.sorts  = sorts;
  const pages = [];
  let cursor;
  do {
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${dbId}/query`, 'POST', body);
    pages.push(...data.results);
    cursor = data.next_cursor;
  } while (cursor);
  return pages;
}

function propText(page, name) {
  const p = page.properties[name];
  if (!p) return '';
  if (p.type === 'title')     return p.title.map(t => t.plain_text).join('');
  if (p.type === 'rich_text') return p.rich_text.map(t => t.plain_text).join('');
  if (p.type === 'select')    return p.select?.name || '';
  if (p.type === 'multi_select') return p.multi_select.map(s => s.name);
  if (p.type === 'number')    return p.number;
  if (p.type === 'checkbox')  return p.checkbox;
  return '';
}

// ─── State ────────────────────────────────────────────────────────────────────
let masterItems = [];
let trips       = [];
let tripItems   = {};   // tripId -> [items]
let currentTab  = 'pack';

let packState = {
  qty:     {},
  worn:    new Set(),
  flagged: new Set(),
  filters: { season: new Set(), conditions: new Set(), duration: new Set(), transport: new Set(), type: new Set() },
  collapsed:    new Set(),
  moving:       null,
  editingItem:  null,
  editingSection: null,
  adding:       null,
  view:         'all',
  tripForm:     { name: '', destination: '', season: '', duration: '', transport: '', type: [], conditions: [] },
  saving:       false,
  saveMsg:      '',
};

const TAGS = {
  season:     ['spring','summer','fall','winter'],
  conditions: ['rain/wet','humid','mixed/unpredictable'],
  duration:   ['weekend','week','2+ weeks'],
  transport:  ['carry-on','checked bag','road trip'],
  type:       ['leisure','work','outdoor','formal'],
};
const ALL   = TAGS.season;
const ALL_C = TAGS.conditions;
const ALL_D = TAGS.duration;
const ALL_T = TAGS.transport;
const ALL_Y = TAGS.type;

// ─── Load master items from Notion ───────────────────────────────────────────
async function loadMasterItems() {
  const pages = await queryDatabase(CONFIG.MASTER_DB_ID, null, [{ property: 'Category', direction: 'ascending' }]);
  masterItems = pages.map(p => ({
    id:         p.id,
    name:       propText(p, 'Item'),
    cat:        propText(p, 'Category'),
    season:     propText(p, 'Season')     || ALL,
    conditions: propText(p, 'Conditions') || ALL_C,
    duration:   propText(p, 'Duration')   || ALL_D,
    transport:  propText(p, 'Transport')  || ALL_T,
    type:       propText(p, 'Trip type')  || ALL_Y,
  }));
}

// ─── Load trips ───────────────────────────────────────────────────────────────
async function loadTrips() {
  const pages = await queryDatabase(CONFIG.TRIPS_DB_ID, null, [{ property: 'created_time', direction: 'descending' }]);
  trips = pages.map(p => ({
    id:          p.id,
    name:        propText(p, 'Trip name'),
    destination: propText(p, 'Destination'),
    season:      propText(p, 'Season'),
    duration:    propText(p, 'Duration'),
    transport:   propText(p, 'Transport'),
    type:        propText(p, 'Trip type'),
    conditions:  propText(p, 'Conditions'),
    created:     p.created_time,
  }));
}

// ─── Load trip items ──────────────────────────────────────────────────────────
async function loadTripItems(tripId) {
  if (tripItems[tripId]) return;
  const pages = await queryDatabase(CONFIG.ITEMS_DB_ID, {
    property: 'Trip name',
    rich_text: { equals: tripId },
  });
  tripItems[tripId] = pages.map(p => ({
    id:       p.id,
    name:     propText(p, 'Item name'),
    cat:      propText(p, 'Category'),
    qty:      propText(p, 'Quantity') || 1,
    packed:   propText(p, 'Packed'),
    worn:     propText(p, 'Worn/Used'),
    notionId: p.id,
  }));
}

// ─── Save trip ────────────────────────────────────────────────────────────────
async function saveTrip() {
  const f = packState.tripForm;
  if (!f.name) { packState.saveMsg = 'Please enter a trip name.'; renderPack(); return; }

  packState.saving = true;
  packState.saveMsg = '';
  renderPack();

  try {
    // Create trip record
    const tripPage = await notionFetch('/pages', 'POST', {
      parent: { database_id: CONFIG.TRIPS_DB_ID },
      properties: {
        'Trip name':   { title: [{ text: { content: f.name } }] },
        'Destination': { rich_text: [{ text: { content: f.destination } }] },
        'Season':      f.season    ? { select: { name: f.season } }    : undefined,
        'Duration':    f.duration  ? { select: { name: f.duration } }  : undefined,
        'Transport':   f.transport ? { select: { name: f.transport } } : undefined,
        'Trip type':   f.type.length      ? { multi_select: f.type.map(n => ({ name: n })) }      : undefined,
        'Conditions':  f.conditions.length ? { multi_select: f.conditions.map(n => ({ name: n })) } : undefined,
      },
    });

    const tripId = tripPage.id;

    // Save packed items
    const packedIds = Object.entries(packState.qty).filter(([,q]) => q > 0).map(([id]) => id);
    for (const itemId of packedIds) {
      const item = masterItems.find(i => i.id === itemId);
      if (!item) continue;
      await notionFetch('/pages', 'POST', {
        parent: { database_id: CONFIG.ITEMS_DB_ID },
        properties: {
          'Item name': { title: [{ text: { content: item.name } }] },
          'Trip name': { rich_text: [{ text: { content: tripId } }] },
          'Category':  { select: { name: item.cat } },
          'Quantity':  { number: packState.qty[itemId] },
          'Packed':    { checkbox: true },
          'Worn/Used': { checkbox: packState.worn.has(itemId) },
        },
      });
    }

    packState.saving  = false;
    packState.saveMsg = `✓ "${f.name}" saved!`;
    packState.qty     = {};
    packState.worn    = new Set();
    packState.flagged = new Set();
    packState.tripForm = { name: '', destination: '', season: '', duration: '', transport: '', type: [], conditions: [] };
    trips = []; // force reload
    renderPack();
  } catch(e) {
    packState.saving  = false;
    packState.saveMsg = `Error: ${e.message}`;
    renderPack();
  }
}

// ─── Update worn/used on a saved trip item ────────────────────────────────────
async function updateTripItem(notionId, field, value) {
  await notionFetch(`/pages/${notionId}`, 'PATCH', {
    properties: { [field]: { checkbox: value } },
  });
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function showTab(tab) {
  currentTab = tab;
  ['pack','trips','history'].forEach(t => {
    document.getElementById(`view-${t}`).style.display = t === tab ? '' : 'none';
    document.getElementById(`tab-${t}`).className = 'nav-btn' + (t === tab ? ' active' : '');
  });
  if (tab === 'trips')   renderTrips();
  if (tab === 'history') renderHistory();
}

// ─── Filter helpers ───────────────────────────────────────────────────────────
function toggleFilter(dim, val) {
  packState.filters[dim].has(val) ? packState.filters[dim].delete(val) : packState.filters[dim].add(val);
  renderPack();
}

function matchesFilters(item) {
  for (const dim of Object.keys(packState.filters)) {
    const f = packState.filters[dim];
    if (f.size === 0) continue;
    const itemVals = Array.isArray(item[dim]) ? item[dim] : [item[dim]];
    if (![...f].some(v => itemVals.includes(v))) return false;
  }
  return true;
}

function getVisible() {
  const q = document.getElementById('pack-search')?.value.toLowerCase() || '';
  return masterItems.filter(item => {
    if (!matchesFilters(item)) return false;
    if (q && !item.name.toLowerCase().includes(q)) return false;
    if (packState.view === 'packed'  && !(packState.qty[item.id] > 0)) return false;
    if (packState.view === 'flagged' && !packState.flagged.has(item.id)) return false;
    return true;
  });
}

function tagsHtml(dim, vals) {
  return vals.map(v => {
    const on = packState.filters[dim].has(v);
    return `<span class="chip${on?' on':''}" onclick="toggleFilter('${dim}','${v}')">${v}</span>`;
  }).join('');
}

// ─── Pack view ────────────────────────────────────────────────────────────────
function renderPack() {
  const el = document.getElementById('view-pack');
  if (!el) return;

  const visible  = getVisible();
  const cats     = [...new Set(masterItems.map(i => i.cat))];
  const packed   = visible.filter(i => packState.qty[i.id] > 0).length;
  const flagged  = visible.filter(i => packState.flagged.has(i.id)).length;

  const filterHtml = `
    <div class="filter-block">
      <div class="filter-label">Climate</div>
      <div class="filter-row"><span class="filter-dim">Season</span>${tagsHtml('season', TAGS.season)}</div>
      <div class="filter-row"><span class="filter-dim">Conditions</span>${tagsHtml('conditions', TAGS.conditions)}</div>
      <div class="filter-label" style="margin-top:8px">Logistics</div>
      <div class="filter-row"><span class="filter-dim">Duration</span>${tagsHtml('duration', TAGS.duration)}</div>
      <div class="filter-row"><span class="filter-dim">Transport</span>${tagsHtml('transport', TAGS.transport)}</div>
      <div class="filter-row"><span class="filter-dim">Trip type</span>${tagsHtml('type', TAGS.type)}</div>
    </div>`;

  const catsToShow = packState.view === 'all' && !document.getElementById('pack-search')?.value
    ? cats
    : [...new Set(visible.map(i => i.cat))];

  let listHtml = '';
  for (const cat of catsToShow) {
    const items     = visible.filter(i => i.cat === cat);
    const collapsed = packState.collapsed.has(cat);
    const n         = items.filter(i => packState.qty[i.id] > 0).length;
    const editing   = packState.editingSection === cat;
    const safe      = cat.replace(/'/g, "\\'");
    const enc       = encodeURIComponent(cat);

    const titleHtml = editing
      ? `<input class="sec-edit-input" id="sec-edit-${enc}" value="${cat}" onblur="commitSecEdit('${safe}')" onkeydown="secEditKey(event,'${safe}')" onclick="event.stopPropagation()">`
      : `<span class="sec-title">${cat}</span>`;

    listHtml += `<div class="section${collapsed?' collapsed':''}">
      <div class="sec-hdr">
        <div class="sec-title-wrap" onclick="toggleSec('${safe}')">${titleHtml}<i class="ti ti-chevron-down chevron"></i></div>
        <span class="sec-count">${n}/${items.length}</span>
        <button class="sec-edit-btn" onclick="startSecEdit('${safe}')"><i class="ti ti-pencil"></i></button>
      </div>`;

    for (const item of items) {
      const qty     = packState.qty[item.id] || 0;
      const isPacked = qty > 0;
      const isWorn  = packState.worn.has(item.id);
      const isFlagged = packState.flagged.has(item.id);
      const isMoving  = packState.moving === item.id;
      const isEditing = packState.editingItem === item.id;
      const otherCats = cats.filter(c => c !== item.cat);

      const nameHtml = isEditing
        ? `<input class="item-edit-input" id="item-edit-${item.id}" value="${item.name.replace(/"/g,'&quot;')}" onblur="commitItemEdit('${item.id}')" onkeydown="itemEditKey(event,'${item.id}')" onclick="event.stopPropagation()">`
        : `<span class="item-name">${item.name}</span>`;

      const pickerHtml = isMoving
        ? `<div class="move-picker"><div class="move-opt current">${item.cat}</div>${otherCats.map(c=>`<div class="move-opt" onclick="moveItem('${item.id}','${c.replace(/'/g,"\\'")}')" >→ ${c}</div>`).join('')}</div>`
        : '';

      listHtml += `<div class="item-row${isPacked?' packed':''}${isWorn?' worn':''}">
        ${nameHtml}
        <div class="stepper">
          <button class="step-btn" onclick="stepDown('${item.id}')"><i class="ti ti-minus"></i></button>
          <span class="step-n">${qty}</span>
          <button class="step-btn" onclick="stepUp('${item.id}')"><i class="ti ti-plus"></i></button>
        </div>
        <button class="icon-btn worn-btn${isWorn?' active':''}" onclick="toggleWorn('${item.id}')" title="Mark worn/used"><i class="ti ti-shirt"></i></button>
        <button class="icon-btn flag-btn${isFlagged?' active':''}" onclick="toggleFlag('${item.id}')" title="Flag: never used"><i class="ti ti-flag-2"></i></button>
        <button class="icon-btn" onclick="startItemEdit('${item.id}')" title="Rename"><i class="ti ti-pencil"></i></button>
        <button class="icon-btn move-btn" onclick="toggleMove('${item.id}')" title="Move section"><i class="ti ti-arrows-move"></i></button>
        ${pickerHtml}
      </div>`;
    }

    const isAdding = packState.adding === cat;
    listHtml += `<div class="add-row">${isAdding
      ? `<div class="add-input-row visible"><input type="text" id="add-input-${enc}" placeholder="Item name…" onkeydown="addKey(event,'${safe}')"><button class="add-confirm btn" onclick="confirmAdd('${safe}')">Add</button><button class="add-cancel" onclick="cancelAdd()"><i class="ti ti-x"></i></button></div>`
      : `<button class="add-trigger" onclick="showAdd('${safe}')"><i class="ti ti-plus"></i> Add item</button>`
    }</div>`;
    listHtml += '</div>';
  }

  const f = packState.tripForm;
  const formHtml = `
    <div class="trip-form">
      <div class="filter-label" style="margin-bottom:10px">Save this pack as a trip</div>
      ${packState.saveMsg ? `<div class="error-msg">${packState.saveMsg}</div>` : ''}
      <div class="form-row">
        <div class="form-field"><label>Trip name *</label><input type="text" value="${f.name}" oninput="packState.tripForm.name=this.value" placeholder="Arizona — June 2026"></div>
        <div class="form-field"><label>Destination</label><input type="text" value="${f.destination}" oninput="packState.tripForm.destination=this.value" placeholder="Sedona, AZ"></div>
      </div>
      <div class="form-row">
        <div class="form-field"><label>Season</label><select onchange="packState.tripForm.season=this.value"><option value="">—</option>${TAGS.season.map(s=>`<option${f.season===s?' selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label>Duration</label><select onchange="packState.tripForm.duration=this.value"><option value="">—</option>${TAGS.duration.map(s=>`<option${f.duration===s?' selected':''}>${s}</option>`).join('')}</select></div>
        <div class="form-field"><label>Transport</label><select onchange="packState.tripForm.transport=this.value"><option value="">—</option>${TAGS.transport.map(s=>`<option${f.transport===s?' selected':''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveTrip()" ${packState.saving?'disabled':''}>${packState.saving?'Saving…':'Save trip'}</button>
        <button class="btn" onclick="clearPack()">Clear pack</button>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="page-header"><h1>Pack a trip</h1><p>Filter down, toggle items on, save when ready.</p></div>
    ${filterHtml}
    <div class="controls">
      <div class="search-wrap"><input type="text" id="pack-search" placeholder="Search items…" oninput="renderPack()"></div>
      <div class="view-row">
        <button class="view-btn${packState.view==='all'?' active':''}" onclick="setPackView('all')">All</button>
        <button class="view-btn${packState.view==='packed'?' active':''}" onclick="setPackView('packed')">Packed</button>
        <button class="view-btn${packState.view==='flagged'?' active':''}" onclick="setPackView('flagged')">Flagged</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-n">${visible.length}</div><div class="stat-l">visible</div></div>
      <div class="stat"><div class="stat-n">${packed}</div><div class="stat-l">packed</div></div>
      <div class="stat"><div class="stat-n">${flagged}</div><div class="stat-l">flagged</div></div>
    </div>
    ${listHtml || '<div class="empty">No items match the current filters.</div>'}
    ${formHtml}`;

  if (packState.editingSection) {
    const inp = document.getElementById('sec-edit-' + encodeURIComponent(packState.editingSection));
    if (inp) { inp.focus(); inp.select(); }
  }
  if (packState.editingItem) {
    const inp = document.getElementById('item-edit-' + packState.editingItem);
    if (inp) { inp.focus(); inp.select(); }
  }
  if (packState.adding) {
    const inp = document.getElementById('add-input-' + encodeURIComponent(packState.adding));
    if (inp) inp.focus();
  }
}

// ─── Pack interactions ────────────────────────────────────────────────────────
function stepUp(id)   { packState.qty[id] = (packState.qty[id]||0)+1; renderPack(); }
function stepDown(id) { packState.qty[id] = Math.max(0,(packState.qty[id]||0)-1); renderPack(); }
function toggleWorn(id) { packState.worn.has(id)?packState.worn.delete(id):packState.worn.add(id); renderPack(); }
function toggleFlag(id) { packState.flagged.has(id)?packState.flagged.delete(id):packState.flagged.add(id); renderPack(); }
function setPackView(v) { packState.view = v; renderPack(); }
function clearPack()    { packState.qty={}; packState.worn=new Set(); packState.flagged=new Set(); renderPack(); }

function toggleSec(cat) { packState.collapsed.has(cat)?packState.collapsed.delete(cat):packState.collapsed.add(cat); renderPack(); }
function startSecEdit(cat)  { packState.editingSection=cat; packState.editingItem=null; packState.moving=null; renderPack(); }
function commitSecEdit(old) {
  const el = document.getElementById('sec-edit-'+encodeURIComponent(old));
  const nw = el?.value.trim();
  if (nw && nw !== old) masterItems.forEach(i => { if (i.cat===old) i.cat=nw; });
  packState.editingSection = null; renderPack();
}
function secEditKey(e,cat) { if(e.key==='Enter')commitSecEdit(cat); if(e.key==='Escape'){packState.editingSection=null;renderPack();} }

function startItemEdit(id)  { packState.editingItem=id; packState.editingSection=null; packState.moving=null; renderPack(); }
function commitItemEdit(id) {
  const el = document.getElementById('item-edit-'+id);
  const item = masterItems.find(i=>i.id===id);
  if (item && el?.value.trim()) item.name = el.value.trim();
  packState.editingItem = null; renderPack();
}
function itemEditKey(e,id) { if(e.key==='Enter')commitItemEdit(id); if(e.key==='Escape'){packState.editingItem=null;renderPack();} }

function toggleMove(id) { packState.moving = packState.moving===id?null:id; renderPack(); }
function moveItem(id,newCat) { const item=masterItems.find(i=>i.id===id); if(item)item.cat=newCat; packState.moving=null; renderPack(); }

let nextLocalId = 9000;
function showAdd(cat)   { packState.adding=cat; packState.moving=null; renderPack(); }
function cancelAdd()    { packState.adding=null; renderPack(); }
function confirmAdd(cat) {
  const inp = document.getElementById('add-input-'+encodeURIComponent(cat));
  const name = inp?.value.trim();
  if (!name) { cancelAdd(); return; }
  masterItems.push({ id:'local-'+(nextLocalId++), name, cat, season:ALL, conditions:ALL_C, duration:ALL_D, transport:ALL_T, type:ALL_Y });
  packState.adding = null; renderPack();
}
function addKey(e,cat) { if(e.key==='Enter')confirmAdd(cat); if(e.key==='Escape')cancelAdd(); }

document.addEventListener('click', e => {
  if (packState.moving && !e.target.closest('.move-picker') && !e.target.closest('.move-btn')) {
    packState.moving = null; renderPack();
  }
});

// ─── Trips view ───────────────────────────────────────────────────────────────
async function renderTrips() {
  const el = document.getElementById('view-trips');
  el.innerHTML = '<div class="loading">Loading trips…</div>';
  try {
    if (!trips.length) await loadTrips();
    if (!trips.length) { el.innerHTML = '<div class="page-header"><h1>My trips</h1></div><div class="empty">No saved trips yet. Pack something and save it!</div>'; return; }

    let html = '<div class="page-header"><h1>My trips</h1><p>Click a trip to view and update worn/used status.</p></div><div class="trips-list">';
    for (const trip of trips) {
      html += `<div class="trip-card" onclick="openTrip('${trip.id}')">
        <div class="trip-card-name">${trip.name}</div>
        <div class="trip-card-meta">
          ${trip.destination ? `<span>📍 ${trip.destination}</span>` : ''}
          ${trip.season ? `<span>🌤 ${trip.season}</span>` : ''}
          ${trip.duration ? `<span>📅 ${trip.duration}</span>` : ''}
          ${trip.transport ? `<span>🚗 ${trip.transport}</span>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div class="error-msg">Error loading trips: ${e.message}</div>`;
  }
}

async function openTrip(tripId) {
  const el = document.getElementById('view-trips');
  el.innerHTML = '<div class="loading">Loading trip items…</div>';
  try {
    await loadTripItems(tripId);
    const trip = trips.find(t => t.id === tripId);
    const items = tripItems[tripId] || [];
    const cats  = [...new Set(items.map(i => i.cat))];

    let html = `<div class="page-header">
      <h1>${trip.name}</h1>
      <p>${trip.destination || ''} ${trip.season ? '· '+trip.season : ''} ${trip.duration ? '· '+trip.duration : ''}</p>
    </div>
    <div class="btn-row" style="margin-bottom:1rem">
      <button class="btn" onclick="renderTrips()">← Back to trips</button>
    </div>`;

    for (const cat of cats) {
      const catItems = items.filter(i => i.cat === cat);
      html += `<div class="section"><div class="sec-hdr"><div class="sec-title-wrap"><span class="sec-title">${cat}</span></div><span class="sec-count">${catItems.length}</span></div>`;
      for (const item of catItems) {
        html += `<div class="item-row${item.packed?' packed':''}${item.worn?' worn':''}">
          <span class="item-name">${item.name}</span>
          <span style="font-size:12px;color:var(--text3);margin-right:4px">×${item.qty}</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text2);cursor:pointer">
            <input type="checkbox" ${item.worn?'checked':''} onchange="toggleWornSaved('${tripId}','${item.notionId}',this.checked)"> Worn/Used
          </label>
        </div>`;
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div class="error-msg">Error: ${e.message}</div>`;
  }
}

async function toggleWornSaved(tripId, notionId, value) {
  try {
    await updateTripItem(notionId, 'Worn/Used', value);
    const item = tripItems[tripId]?.find(i => i.notionId === notionId);
    if (item) item.worn = value;
  } catch(e) {
    alert('Error updating: ' + e.message);
  }
}

// ─── History view ─────────────────────────────────────────────────────────────
async function renderHistory() {
  const el = document.getElementById('view-history');
  el.innerHTML = '<div class="loading">Loading history…</div>';
  try {
    if (!trips.length) await loadTrips();
    if (!trips.length) { el.innerHTML = '<div class="page-header"><h1>History</h1></div><div class="empty">No trips yet.</div>'; return; }

    // Load all trip items
    for (const trip of trips) await loadTripItems(trip.id);

    // Build item-level history
    const itemHistory = {};
    for (const trip of trips) {
      for (const item of (tripItems[trip.id] || [])) {
        if (!itemHistory[item.name]) itemHistory[item.name] = [];
        itemHistory[item.name].push({ tripName: trip.name, qty: item.qty, worn: item.worn });
      }
    }

    let html = `<div class="page-header"><h1>History</h1><p>What you've packed and worn across all trips.</p></div>
    <table class="history-table">
      <thead><tr><th>Item</th><th>Trips packed</th><th>Times worn/used</th></tr></thead><tbody>`;

    const sorted = Object.entries(itemHistory).sort((a,b) => b[1].length - a[1].length);
    for (const [name, records] of sorted) {
      const worn = records.filter(r => r.worn).length;
      html += `<tr>
        <td>${name}</td>
        <td><span class="badge packed">${records.length}×</span> ${records.map(r=>r.tripName).join(', ')}</td>
        <td>${worn > 0 ? `<span class="badge worn">${worn}×</span>` : '<span style="color:var(--text3)">—</span>'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div class="error-msg">Error: ${e.message}</div>`;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  document.getElementById('view-pack').innerHTML = '<div class="loading">Loading your packing list from Notion…</div>';
  try {
    await loadMasterItems();
    renderPack();
  } catch(e) {
    document.getElementById('view-pack').innerHTML = `<div class="error-msg">Could not connect to Notion: ${e.message}<br><br>Check that your token in config.js is correct and that the integration has access to your databases.</div>`;
  }
})();
