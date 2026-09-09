const WORKER = 'https://packing-proxy.big-glasses.workers.dev/notion';
const MASTER = '18f5a4e7ab114c4c9f014d908c2fadd6';
const TRIPS  = '550336b247364defb7594675f913ac11';
const TITEMS = 'e7d2a1f307704a52986a9d66e50bba2b';

const SEASONS = ['all','spring','summer','fall','winter'];
const CONDS   = ['all','cold','heat','humid','mixed/unpredictable','rain/wet','sun'];
const DURS    = ['all','day trip','weekend+'];
const TRANS   = ['all','day bag','checked bag'];
const TYPES   = ['all','beach','concert','day trip','desert','formal','funeral','hiking','leisure','mountains','outdoor','road trip','wedding','work'];

const CAT_COLORS = [
  '#00d4aa','#ff6b6b','#ffd93d','#c77dff','#4cc9f0','#ff9a3c','#ff6eb4','#6bcb77','#a0c4ff'
];

let items=[], trips=[], tripItems={}, curTab='pack', nextId=9000;
let catColorMap = {};

let S = {
  qty:{}, flagged:new Set(),
  filters:{ season:new Set(), conditions:new Set(), duration:new Set(), transport:new Set(), type:new Set() },
  collapsed:new Set(), moving:null, editItem:null, editSec:null, adding:null,
  view:'all', editingTripId:null,
  form:{ name:'', destination:'', season:'', duration:'', transport:'', type:[] },
  saving:false, msg:'', msgOk:false,
};

async function nfetch(path, method='GET', body=null) {
  const r = await fetch(WORKER + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function fetchAll(dbId, filter=null) {
  const pages=[], body=filter?{filter}:{};
  let cursor;
  do {
    if (cursor) body.start_cursor = cursor;
    const d = await nfetch(`/databases/${dbId}/query`, 'POST', body);
    if (d.results) pages.push(...d.results);
    cursor = d.next_cursor;
  } while (cursor);
  return pages;
}

function pv(props, name) {
  const p = props?.[name];
  if (!p) return '';
  if (p.type==='title')        return p.title?.map(t=>t.plain_text).join('')||'';
  if (p.type==='rich_text')    return p.rich_text?.map(t=>t.plain_text).join('')||'';
  if (p.type==='select')       return p.select?.name||'';
  if (p.type==='multi_select') return p.multi_select?.map(s=>s.name)||[];
  if (p.type==='number')       return p.number;
  if (p.type==='checkbox')     return p.checkbox;
  return '';
}

async function loadItems() {
  document.getElementById('view-pack').innerHTML = '<div class="loading">Loading your packing list from Notion</div>';
  try {
    const pages = await fetchAll(MASTER);
    items = pages.map(p => ({
      id: p.id,
      name: pv(p.properties,'Item'),
      cat:  pv(p.properties,'Category'),
      season:     pv(p.properties,'Season')               || ['all'],
      conditions: pv(p.properties,'Conditions')          || ['all'],
      duration:   pv(p.properties,'Duration')            || ['all'],
      transport:  pv(p.properties,'On-Journey Transport') || ['all'],
      type:       pv(p.properties,'Type')                || ['all'],
    })).filter(i => i.name && i.cat);

    const cats = [...new Set(items.map(i=>i.cat))].filter(Boolean);
    cats.forEach((c,i) => { catColorMap[c] = CAT_COLORS[i % CAT_COLORS.length]; });

    renderPack();
  } catch(e) {
    document.getElementById('view-pack').innerHTML = `<div class="error-msg">Could not load from Notion: ${e.message}</div>`;
  }
}

function matches(item) {
  for (const dim of Object.keys(S.filters)) {
    const f = S.filters[dim];
    if (f.size === 0) continue;
    const vals = Array.isArray(item[dim]) ? item[dim] : [item[dim]];
    if (vals.includes('all')) continue;
    if (![...f].some(v => vals.includes(v) || v==='all')) return false;
  }
  return true;
}

function getVis() {
  const q = document.getElementById('pack-search')?.value.toLowerCase()||'';
  return items.filter(i => {
    if (!matches(i)) return false;
    if (q && !i.name.toLowerCase().includes(q)) return false;
    if (S.view==='packed'  && !((S.qty[i.id]||0)>0)) return false;
    if (S.view==='flagged' && !S.flagged.has(i.id))  return false;
    return true;
  });
}

function thtml(dim, vals) {
  return `<div class="filter-row dim-${dim}">${vals.map(v =>
    `<span class="chip${S.filters[dim].has(v)?' on':''}" onclick="tf('${dim}','${v.replace(/'/g,"\\'")}')"> ${v}</span>`
  ).join('')}</div>`;
}

function tf(dim, val) { S.filters[dim].has(val)?S.filters[dim].delete(val):S.filters[dim].add(val); renderPack(); }
function sv(v) { S.view=v; renderPack(); }
function toggleSec(c) { S.collapsed.has(c)?S.collapsed.delete(c):S.collapsed.add(c); renderPack(); }
function stepUp(id)   { S.qty[id]=(S.qty[id]||0)+1; renderPack(); }
function stepDown(id) { S.qty[id]=Math.max(0,(S.qty[id]||0)-1); renderPack(); }
function toggleFlag(id) { S.flagged.has(id)?S.flagged.delete(id):S.flagged.add(id); renderPack(); }
function clearPack()  { S.qty={}; S.flagged=new Set(); renderPack(); }
function toggleMove(id) { S.moving=S.moving===id?null:id; renderPack(); }
function moveItem(id,cat) { const i=items.find(x=>x.id===id); if(i)i.cat=cat; S.moving=null; renderPack(); }

function startSecEdit(c)   { S.editSec=c; S.editItem=null; S.moving=null; renderPack(); }
function commitSecEdit(old) {
  const el=document.getElementById('sei-'+encodeURIComponent(old));
  const nw=el?.value.trim();
  if(nw&&nw!==old) { items.forEach(i=>{if(i.cat===old)i.cat=nw;}); catColorMap[nw]=catColorMap[old]; delete catColorMap[old]; }
  S.editSec=null; renderPack();
}
function secKey(e,c) { if(e.key==='Enter')commitSecEdit(c); if(e.key==='Escape'){S.editSec=null;renderPack();} }
function startItemEdit(id) { S.editItem=id; S.editSec=null; S.moving=null; renderPack(); }
function commitItemEdit(id) {
  const el=document.getElementById('iei-'+id);
  const i=items.find(x=>x.id===id);
  if(i&&el?.value.trim()) i.name=el.value.trim();
  S.editItem=null; renderPack();
}
function itemKey(e,id) { if(e.key==='Enter')commitItemEdit(id); if(e.key==='Escape'){S.editItem=null;renderPack();} }
function showAdd(c)    { S.adding=c; S.moving=null; renderPack(); }
function cancelAdd()   { S.adding=null; renderPack(); }
function confirmAdd(c) {
  const inp=document.getElementById('ai-'+encodeURIComponent(c));
  const n=inp?.value.trim();
  if(!n){cancelAdd();return;}
  items.push({id:'local-'+(nextId++),name:n,cat:c,season:['all'],conditions:['all'],duration:['all'],transport:['all'],type:['all']});
  S.adding=null; renderPack();
}
function addKey(e,c) { if(e.key==='Enter')confirmAdd(c); if(e.key==='Escape')cancelAdd(); }
document.addEventListener('click', e => {
  if (S.moving && !e.target.closest('.move-picker') && !e.target.closest('.move-btn')) { S.moving=null; renderPack(); }
});

async function saveTrip() {
  const f=S.form;
  if(!f.name){S.msg='Enter a trip name.';S.msgOk=false;renderPack();return;}
  const packed=Object.entries(S.qty).filter(([,q])=>q>0).map(([id])=>id);
  if(!packed.length){S.msg='No items packed yet.';S.msgOk=false;renderPack();return;}
  S.saving=true; S.msg=''; renderPack();
  try {
    const tp = await nfetch('/pages','POST',{
      parent:{database_id:TRIPS},
      properties:{
        'Trip name':  {title:[{text:{content:f.name}}]},
        'Destination':{rich_text:[{text:{content:f.destination||''}}]},
        ...(f.season   ?{'Season':   {select:{name:f.season}}}   :{}),
        ...(f.duration ?{'Duration': {select:{name:f.duration}}} :{}),
        ...(f.transport?{'Transport':{select:{name:f.transport}}}:{}),
        ...(f.type.length?{'Trip type':{multi_select:f.type.map(n=>({name:n}))}}:{}),
      }
    });
    const tid=tp.id;
    for (const iid of packed) {
      const item=items.find(i=>i.id===iid);
      if(!item) continue;
      await nfetch('/pages','POST',{
        parent:{database_id:TITEMS},
        properties:{
          'Item name':{title:[{text:{content:item.name}}]},
          'Trip name':{rich_text:[{text:{content:tid}}]},
          'Category': {select:{name:item.cat}},
          'Quantity': {number:S.qty[iid]},
          'Packed':   {checkbox:true},
          'Worn/Used':{checkbox:false},
        }
      });
    }
    S.saving=false; S.msg=`"${f.name}" saved to Notion!`; S.msgOk=true;
    S.qty={}; S.flagged=new Set();
    S.form={name:'',destination:'',season:'',duration:'',transport:'',type:[]};
    trips=[];
    renderPack();
  } catch(e) { S.saving=false; S.msg='Error: '+e.message; S.msgOk=false; renderPack(); }
}

async function startEditTrip(tid) {
  const trEl=document.getElementById('view-trips');
  if(trEl) trEl.innerHTML='<div class="loading">Loading trip for editing</div>';
  try {
    await loadTrips();
    const t = trips.find(x=>x.id===tid) || {};
    if(!tripItems[tid]){
      const pages=await fetchAll(TITEMS,{property:'Trip name',rich_text:{equals:tid}});
      tripItems[tid]=pages.map(p=>({
        id:p.id, name:pv(p.properties,'Item name'), cat:pv(p.properties,'Category'),
        qty:pv(p.properties,'Quantity')||1, packed:pv(p.properties,'Packed'), worn:pv(p.properties,'Worn/Used'),
      }));
    }
    S.qty={}; S.flagged=new Set();
    S.filters={ season:new Set(), conditions:new Set(), duration:new Set(), transport:new Set(), type:new Set() };
    S.view='all';
    for (const ti of tripItems[tid]) {
      let m = items.find(i=>i.name===ti.name);
      if(!m){
        m = {id:'local-'+(nextId++), name:ti.name, cat:ti.cat||'Other', season:['all'], conditions:['all'], duration:['all'], transport:['all'], type:['all']};
        items.push(m);
      }
      S.qty[m.id]=ti.qty||1;
    }
    S.form={
      name:t.name||'', destination:t.destination||'',
      season:t.season||'', duration:t.duration||'', transport:t.transport||'',
      type:Array.isArray(t.type)?t.type:[],
    };
    S.editingTripId=tid; S.msg='';
    showTab('pack');
    const s=document.getElementById('pack-search'); if(s) s.value='';
    renderPack();
  } catch(e){ if(trEl) trEl.innerHTML=`<div class="error-msg">Error: ${e.message}</div>`; }
}

function cancelEditTrip() {
  S.editingTripId=null; S.qty={}; S.flagged=new Set();
  S.form={name:'',destination:'',season:'',duration:'',transport:'',type:[]};
  showTab('trips');
}

async function updateTrip() {
  const f=S.form, tid=S.editingTripId;
  if(!f.name){S.msg='Enter a trip name.';S.msgOk=false;renderPack();return;}
  const packedIds=Object.entries(S.qty).filter(([,q])=>q>0).map(([id])=>id);
  if(!packedIds.length){S.msg='No items packed — add some or cancel the edit.';S.msgOk=false;renderPack();return;}
  S.saving=true; S.msg=''; renderPack();
  try {
    await nfetch(`/pages/${tid}`,'PATCH',{
      properties:{
        'Trip name':  {title:[{text:{content:f.name}}]},
        'Destination':{rich_text:[{text:{content:f.destination||''}}]},
        'Season':     f.season   ?{select:{name:f.season}}   :{select:null},
        'Duration':   f.duration ?{select:{name:f.duration}} :{select:null},
        'Transport':  f.transport?{select:{name:f.transport}}:{select:null},
        'Trip type':  {multi_select:f.type.map(n=>({name:n}))},
      }
    });

    // Diff against what's currently saved, so unchanged items (and their
    // Worn/Used status) are left alone rather than deleted and recreated.
    const oldPages = await fetchAll(TITEMS,{property:'Trip name',rich_text:{equals:tid}});
    const oldByName = {};
    oldPages.forEach(p=>{ oldByName[pv(p.properties,'Item name')] = p; });

    const newByName = {};
    for (const iid of packedIds) {
      const item=items.find(i=>i.id===iid);
      if(item) newByName[item.name] = {item, qty:S.qty[iid]};
    }

    for (const [name, page] of Object.entries(oldByName)) {
      if (newByName[name]) {
        const {qty} = newByName[name];
        if (pv(page.properties,'Quantity') !== qty) {
          await nfetch(`/pages/${page.id}`,'PATCH',{properties:{'Quantity':{number:qty}}});
        }
        delete newByName[name];
      } else {
        await nfetch(`/pages/${page.id}`,'PATCH',{archived:true});
      }
    }
    for (const {item, qty} of Object.values(newByName)) {
      await nfetch('/pages','POST',{
        parent:{database_id:TITEMS},
        properties:{
          'Item name':{title:[{text:{content:item.name}}]},
          'Trip name':{rich_text:[{text:{content:tid}}]},
          'Category': {select:{name:item.cat}},
          'Quantity': {number:qty},
          'Packed':   {checkbox:true},
          'Worn/Used':{checkbox:false},
        }
      });
    }

    S.saving=false; S.msg=`"${f.name}" updated!`; S.msgOk=true;
    S.qty={}; S.flagged=new Set(); S.editingTripId=null;
    S.form={name:'',destination:'',season:'',duration:'',transport:'',type:[]};
    trips=[]; delete tripItems[tid];
    renderPack();
  } catch(e) { S.saving=false; S.msg='Error: '+e.message; S.msgOk=false; renderPack(); }
}

function renderPack() {
  const el=document.getElementById('view-pack');
  if(!el) return;
  const vis=getVis();
  const cats=[...new Set(items.map(i=>i.cat))].filter(Boolean);
  const packed=vis.filter(i=>(S.qty[i.id]||0)>0).length;
  const flagged=vis.filter(i=>S.flagged.has(i.id)).length;
  const q=document.getElementById('pack-search')?.value||'';
  const catsToShow=S.view==='all'&&!q ? cats : [...new Set(vis.map(i=>i.cat))];

  let list='';
  for (const cat of catsToShow) {
    const citems=vis.filter(i=>i.cat===cat);
    const coll=S.collapsed.has(cat);
    const n=citems.filter(i=>(S.qty[i.id]||0)>0).length;
    const esec=S.editSec===cat;
    const safe=cat.replace(/'/g,"\\'"), enc=encodeURIComponent(cat);
    const col=catColorMap[cat]||'#9090a8';
    const tit=esec
      ?`<input class="sec-edit-input" id="sei-${enc}" value="${cat}" onblur="commitSecEdit('${safe}')" onkeydown="secKey(event,'${safe}')" onclick="event.stopPropagation()">`
      :`<span class="sec-title" style="color:${col}">${cat}</span>`;
    list+=`<div class="section${coll?' collapsed':''}">
      <div class="sec-hdr">
        <div class="sec-title-wrap" onclick="toggleSec('${safe}')">
          <span class="sec-dot" style="background:${col}"></span>
          ${tit}
          <i class="ti ti-chevron-down chevron" aria-hidden="true"></i>
        </div>
        <span class="sec-count">${n}/${citems.length}</span>
        <button class="sec-edit-btn" onclick="startSecEdit('${safe}')"><i class="ti ti-pencil" aria-hidden="true"></i></button>
      </div>`;
    for (const item of citems) {
      const qty=S.qty[item.id]||0, pk=qty>0, fl=S.flagged.has(item.id);
      const mv=S.moving===item.id, ed=S.editItem===item.id;
      const ocat=cats.filter(c=>c!==item.cat);
      const nm=ed
        ?`<input class="item-edit-input" id="iei-${item.id}" value="${item.name.replace(/"/g,'&quot;')}" onblur="commitItemEdit('${item.id}')" onkeydown="itemKey(event,'${item.id}')" onclick="event.stopPropagation()">`
        :`<span class="item-name">${item.name}</span>`;
      const picker=mv?`<div class="move-picker"><div class="move-opt current">${item.cat}</div>${ocat.map(c=>`<div class="move-opt" onclick="moveItem('${item.id}','${c.replace(/'/g,"\\'")}')"><span style="color:${catColorMap[c]||'#9090a8'}">●</span> ${c}</div>`).join('')}</div>`:'';
      list+=`<div class="item-row${pk?' packed':''}">
        ${nm}
        <div class="stepper">
          <button class="step-btn" onclick="stepDown('${item.id}')"><i class="ti ti-minus" aria-hidden="true"></i></button>
          <span class="step-n">${qty}</span>
          <button class="step-btn" onclick="stepUp('${item.id}')"><i class="ti ti-plus" aria-hidden="true"></i></button>
        </div>
        <button class="icon-btn flag${fl?' active':''}" onclick="toggleFlag('${item.id}')" title="Flag: never used"><i class="ti ti-flag-2" aria-hidden="true"></i></button>
        <button class="icon-btn" onclick="startItemEdit('${item.id}')" title="Rename"><i class="ti ti-pencil" aria-hidden="true"></i></button>
        <button class="icon-btn move-btn" onclick="toggleMove('${item.id}')" title="Move section"><i class="ti ti-arrows-move" aria-hidden="true"></i></button>
        ${picker}
      </div>`;
    }
    const ia=S.adding===cat;
    list+=`<div class="add-row">${ia
      ?`<div class="add-input-row visible"><input type="text" id="ai-${enc}" placeholder="Item name…" onkeydown="addKey(event,'${safe}')"><button class="add-confirm" onclick="confirmAdd('${safe}')">Add</button><button class="add-cancel" onclick="cancelAdd()"><i class="ti ti-x" aria-hidden="true"></i></button></div>`
      :`<button class="add-trigger" onclick="showAdd('${safe}')"><i class="ti ti-plus" aria-hidden="true"></i> Add item</button>`
    }</div></div>`;
  }
  if(!catsToShow.length) list='<div class="empty">No items match the current filters.</div>';

  const f=S.form;
  const editing=!!S.editingTripId;
  const form=`<div class="trip-form">
    <div class="form-label">${editing?`Editing “${f.name||'trip'}” — adjust items, then update`:'Save this pack as a trip'}</div>
    ${S.msg?`<div class="${S.msgOk?'success-msg':'error-msg'}">${S.msg}</div>`:''}
    <div class="form-row">
      <div class="form-field"><label>Trip name *</label><input type="text" value="${f.name}" oninput="S.form.name=this.value" placeholder="Nashville — September 2026"></div>
      <div class="form-field"><label>Destination</label><input type="text" value="${f.destination}" oninput="S.form.destination=this.value" placeholder="Nashville, TN"></div>
    </div>
    <div class="form-row">
      <div class="form-field"><label>Season</label><select onchange="S.form.season=this.value"><option value="">—</option>${SEASONS.filter(s=>s!=='all').map(s=>`<option${f.season===s?' selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field"><label>Duration</label><select onchange="S.form.duration=this.value"><option value="">—</option>${DURS.filter(s=>s!=='all').map(s=>`<option${f.duration===s?' selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-field"><label>Transport</label><select onchange="S.form.transport=this.value"><option value="">—</option>${TRANS.filter(s=>s!=='all').map(s=>`<option${f.transport===s?' selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" onclick="${editing?'updateTrip()':'saveTrip()'}" ${S.saving?'disabled':''}>${S.saving?(editing?'Updating…':'Saving…'):(editing?'Update trip':'Save trip')}</button>
      ${editing?`<button class="btn" onclick="cancelEditTrip()">Cancel edit</button>`:`<button class="btn" onclick="clearPack()">Clear pack</button>`}
    </div>
  </div>`;

  el.innerHTML=`
    <div class="page-header"><h1>${editing?'Edit trip':'Pack a trip'}</h1><p>${editing?'Adjust what you\'re bringing, then update the saved trip.':'Filter down, toggle items on, save when ready.'}</p></div>
    <div class="filter-block">
      <div class="filter-section">
        <div class="filter-label">Climate</div>
        <div class="filter-row"><span class="filter-dim">Season</span>${`<div class="filter-row dim-season">${SEASONS.map(v=>`<span class="chip${S.filters.season.has(v)?' on':''}" onclick="tf('season','${v}')">${v}</span>`).join('')}</div>`}</div>
        <div class="filter-row"><span class="filter-dim">Conditions</span>${`<div class="filter-row dim-conditions">${CONDS.map(v=>`<span class="chip${S.filters.conditions.has(v)?' on':''}" onclick="tf('conditions','${v.replace(/'/g,"\\'")}')"> ${v}</span>`).join('')}</div>`}</div>
      </div>
      <div class="filter-section">
        <div class="filter-label">Logistics</div>
        <div class="filter-row"><span class="filter-dim">Duration</span><div class="filter-row dim-duration">${DURS.map(v=>`<span class="chip${S.filters.duration.has(v)?' on':''}" onclick="tf('duration','${v}')">${v}</span>`).join('')}</div></div>
        <div class="filter-row"><span class="filter-dim">Transport</span><div class="filter-row dim-transport">${TRANS.map(v=>`<span class="chip${S.filters.transport.has(v)?' on':''}" onclick="tf('transport','${v}')">${v}</span>`).join('')}</div></div>
        <div class="filter-row"><span class="filter-dim">Trip type</span><div class="filter-row dim-type">${TYPES.map(v=>`<span class="chip${S.filters.type.has(v)?' on':''}" onclick="tf('type','${v.replace(/'/g,"\\'")}')"> ${v}</span>`).join('')}</div></div>
      </div>
    </div>
    <div class="controls">
      <div class="search-wrap"><input type="text" id="pack-search" placeholder="Search items…" oninput="renderPack()"></div>
      <div class="view-row">
        <button class="view-btn${S.view==='all'?' active':''}" onclick="sv('all')">All</button>
        <button class="view-btn${S.view==='packed'?' active':''}" onclick="sv('packed')">Packed</button>
        <button class="view-btn${S.view==='flagged'?' active':''}" onclick="sv('flagged')">Flagged</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-n">${vis.length}</div><div class="stat-l">visible</div></div>
      <div class="stat"><div class="stat-n packed-color">${packed}</div><div class="stat-l">packed</div></div>
      <div class="stat"><div class="stat-n flagged-color">${flagged}</div><div class="stat-l">flagged</div></div>
    </div>
    ${list}${form}`;

  if(S.editSec){const i=document.getElementById('sei-'+encodeURIComponent(S.editSec));if(i){i.focus();i.select();}}
  if(S.editItem){const i=document.getElementById('iei-'+S.editItem);if(i){i.focus();i.select();}}
  if(S.adding){const i=document.getElementById('ai-'+encodeURIComponent(S.adding));if(i)i.focus();}
}

async function loadTrips() {
  if(trips.length) return trips;
  const pages=await fetchAll(TRIPS);
  trips=pages.map(p=>({
    id:p.id, name:pv(p.properties,'Trip name'), destination:pv(p.properties,'Destination'),
    season:pv(p.properties,'Season'), duration:pv(p.properties,'Duration'),
    transport:pv(p.properties,'Transport'), type:pv(p.properties,'Trip type')||[],
  }));
  return trips;
}

async function renderTrips() {
  const el=document.getElementById('view-trips');
  el.innerHTML='<div class="loading">Loading trips</div>';
  try {
    await loadTrips();
    if(!trips.length){el.innerHTML='<div class="page-header"><h1>My trips</h1></div><div class="empty">No saved trips yet.</div>';return;}
    let html='<div class="page-header"><h1>My trips</h1><p>Click a trip to update worn/used status, or edit to change what\'s packed.</p></div>';
    for(const t of trips){
      html+=`<div class="trip-card" onclick="openTrip('${t.id}','${t.name.replace(/'/g,"\\'")}')">
        <div class="trip-card-name">${t.name}</div>
        <div class="trip-card-meta">${t.destination?`<span>📍 ${t.destination}</span>`:''} ${t.season?`<span>${t.season}</span>`:''} ${t.duration?`<span>${t.duration}</span>`:''}</div>
        <button class="btn" style="margin-top:8px" onclick="event.stopPropagation();startEditTrip('${t.id}')">Edit</button>
      </div>`;
    }
    el.innerHTML=html;
  } catch(e){el.innerHTML=`<div class="error-msg">Error: ${e.message}</div>`;}
}

async function openTrip(tid, tname) {
  const el=document.getElementById('view-trips');
  el.innerHTML='<div class="loading">Loading trip</div>';
  try {
    if(!tripItems[tid]){
      const pages=await fetchAll(TITEMS,{property:'Trip name',rich_text:{equals:tid}});
      tripItems[tid]=pages.map(p=>({
        id:p.id, name:pv(p.properties,'Item name'), cat:pv(p.properties,'Category'),
        qty:pv(p.properties,'Quantity')||1, packed:pv(p.properties,'Packed'), worn:pv(p.properties,'Worn/Used'),
      }));
    }
    const pitems=tripItems[tid]||[];
    const cats=[...new Set(pitems.map(i=>i.cat))];
    let html=`<div class="page-header"><h1>${tname}</h1></div>
      <div class="btn-row" style="margin-bottom:1.25rem">
        <button class="btn" onclick="renderTrips()">← Back</button>
        <button class="btn primary" onclick="startEditTrip('${tid}')">Edit trip</button>
      </div>`;
    for(const cat of cats){
      const ci=pitems.filter(i=>i.cat===cat);
      const col=catColorMap[cat]||'#9090a8';
      html+=`<div class="section"><div class="sec-hdr"><div class="sec-title-wrap"><span class="sec-dot" style="background:${col}"></span><span class="sec-title" style="color:${col}">${cat}</span></div><span class="sec-count">${ci.length}</span></div>`;
      for(const item of ci){
        html+=`<div class="item-row${item.packed?' packed':''}">
          <span class="item-name">${item.name}</span>
          <span style="font-size:12px;color:var(--text3);margin-right:8px;font-family:'DM Mono',monospace">×${item.qty}</span>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text2);cursor:pointer">
            <input type="checkbox" ${item.worn?'checked':''} onchange="updateWorn('${tid}','${item.id}',this.checked)"> Worn/used
          </label>
        </div>`;
      }
      html+='</div>';
    }
    el.innerHTML=html;
  } catch(e){el.innerHTML=`<div class="error-msg">Error: ${e.message}</div>`;}
}

async function updateWorn(tid, pid, val) {
  try {
    await nfetch(`/pages/${pid}`,'PATCH',{properties:{'Worn/Used':{checkbox:val}}});
    const item=tripItems[tid]?.find(i=>i.id===pid);
    if(item) item.worn=val;
  } catch(e){alert('Error: '+e.message);}
}

async function renderHistory() {
  const el=document.getElementById('view-history');
  el.innerHTML='<div class="loading">Loading history</div>';
  try {
    await loadTrips();
    if(!trips.length){el.innerHTML='<div class="page-header"><h1>History</h1></div><div class="empty">No trips yet.</div>';return;}
    for(const t of trips){
      if(!tripItems[t.id]){
        const pages=await fetchAll(TITEMS,{property:'Trip name',rich_text:{equals:t.id}});
        tripItems[t.id]=pages.map(p=>({id:p.id,name:pv(p.properties,'Item name'),qty:pv(p.properties,'Quantity')||1,worn:pv(p.properties,'Worn/Used')}));
      }
    }
    const hist={};
    for(const t of trips) for(const i of (tripItems[t.id]||[])){
      if(!hist[i.name])hist[i.name]=[];
      hist[i.name].push({trip:t.name,qty:i.qty,worn:i.worn});
    }
    let html=`<div class="page-header"><h1>History</h1><p>What you've packed and worn across all trips.</p></div>
      <table class="history-table"><thead><tr><th>Item</th><th>Trips packed</th><th>Worn</th></tr></thead><tbody>`;
    for(const [name,recs] of Object.entries(hist).sort((a,b)=>b[1].length-a[1].length)){
      const w=recs.filter(r=>r.worn).length;
      html+=`<tr><td>${name}</td><td><span class="badge packed">${recs.length}×</span> <span style="color:var(--text2)">${recs.map(r=>r.trip).join(', ')}</span></td><td>${w>0?`<span class="badge worn">${w}×</span>`:'<span style="color:var(--text3)">—</span>'}</td></tr>`;
    }
    el.innerHTML=html+'</tbody></table>';
  } catch(e){el.innerHTML=`<div class="error-msg">Error: ${e.message}</div>`;}
}

function showTab(t) {
  curTab=t;
  ['pack','trips','history'].forEach(k=>{
    document.getElementById('view-'+k).style.display=k===t?'':'none';
    document.getElementById('tab-'+k).className='nav-btn'+(k===t?' active':'');
  });
  if(t==='trips') renderTrips();
  if(t==='history') renderHistory();
}

async function reload() { items=[]; trips=[]; tripItems={}; catColorMap={}; await loadItems(); }

loadItems();
