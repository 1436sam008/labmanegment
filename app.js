// =========================
// Firebase config - paste your config if you need to change
// =========================
const firebaseConfig = {
  apiKey: "AIzaSyAazGHrV1YjB1t_NnYNppShKXNuVvG33MY",
  authDomain: "lab-reserve-18c9c.firebaseapp.com",
  projectId: "lab-reserve-18c9c",
  storageBucket: "lab-reserve-18c9c.firebasestorage.app",
  messagingSenderId: "712919141440",
  appId: "1:712919141440:web:f8908b99ae6ed631c4a3a5",
  measurementId: "G-3BYS2MWMJ6"
};

let firebaseReady = false;
let db = null;
let auth = null;
let currentUser = null;
let _cloudWriteLock = false;

// Init firebase if SDK loaded
function initFirebaseIfPossible() {
  if(!window.firebase) {
    document.getElementById('userStatus').textContent = 'Firebase: SDK not loaded';
    return;
  }
  try {
    if(!firebase.apps.length && firebaseConfig && Object.keys(firebaseConfig).length>0) {
      firebase.initializeApp(firebaseConfig);
    }
    auth = firebase.auth();
    db = firebase.firestore();
    firebaseReady = true;
    document.getElementById('userStatus').textContent = 'Firebase: ready (signed out)';
    auth.onAuthStateChanged(u => {
      currentUser = u;
      if(u) {
        document.getElementById('userStatus').textContent = 'Signed in: ' + (u.displayName || u.email || u.uid);
        document.getElementById('btnAuth').textContent = 'Sign out';
        startRealtimeSync();
      } else {
        document.getElementById('userStatus').textContent = 'Signed out';
        document.getElementById('btnAuth').textContent = 'Sign in';
        if(window._studentsUnsub) { try { window._studentsUnsub(); } catch(e){} window._studentsUnsub = null; }
      }
    });
  } catch(err) {
    console.error('Firebase init error', err);
    document.getElementById('userStatus').textContent = 'Firebase init error';
  }
}

/* Save / load to Firestore helpers */
async function saveStudentToFirestore(student) {
  if(!db || !currentUser) return;
  if(!student || !student.id) return;
  try {
    _cloudWriteLock = true;
    const copy = Object.assign({}, student);
    await db.collection('students').doc(String(copy.id)).set(copy, { merge: true });
  } catch (e) {
    console.error('saveStudentToFirestore', e);
  } finally {
    setTimeout(()=> { _cloudWriteLock = false; }, 250);
  }
}

async function saveAllToFirestore() {
  if(!db || !currentUser) return;
  try {
    const batch = db.batch();
    (state.students || []).forEach(s => {
      const ref = db.collection('students').doc(String(s.id));
      batch.set(ref, s, { merge: true });
    });
    _cloudWriteLock = true;
    await batch.commit();
  } catch(e) { console.error('saveAllToFirestore', e); }
  finally { setTimeout(()=> { _cloudWriteLock = false; }, 300); }
}

async function loadFromFirestore() {
  if(!db) return alert('Firestore not initialized');
  try {
    const snap = await db.collection('students').get();
    const cloud = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      d.id = String(d.id || doc.id);
      cloud.push(d);
    });
    if(cloud.length === 0) { alert('No students found in Firestore.'); return; }
    const localMap = new Map((state.students||[]).map(s => [s.id,s]));
    cloud.forEach(c => localMap.set(c.id, c));
    state.students = Array.from(localMap.values());
    save(); renderAll();
    alert(`Loaded ${cloud.length} students from cloud (merged).`);
  } catch(e) { console.error('loadFromFirestore', e); alert('Load failed: '+(e.message||e)); }
}

function startRealtimeSync() {
  if(!db) return console.warn('Firestore not initialized');
  if(window._studentsUnsub) { try { window._studentsUnsub(); } catch(e){} window._studentsUnsub = null; }
  window._studentsUnsub = db.collection('students')
    .onSnapshot(snapshot => {
      if(_cloudWriteLock) return;
      const cloudArr = [];
      snapshot.forEach(doc => {
        const d = doc.data() || {};
        d.id = String(d.id || doc.id);
        cloudArr.push(d);
      });
      const localMap = new Map((state.students||[]).map(s=>[s.id,s]));
      cloudArr.forEach(c => localMap.set(c.id, c));
      const merged = Array.from(localMap.values());
      let needUpdate = merged.length !== (state.students||[]).length;
      if(!needUpdate) {
        for(let i=0;i<merged.length;i++){
          if(!state.students[i] || state.students[i].id !== merged[i].id) { needUpdate = true; break; }
        }
      }
      if(needUpdate) {
        state.students = merged;
        save(); renderAll();
        console.log('Realtime: merged cloud -> local, total:', state.students.length);
      } else {
        state.students = merged;
        renderAll();
      }
    }, error => {
      console.error('Realtime snapshot error', error);
    });
}

// =========================
// App state & helpers
// =========================
const KEY = 'lab_v2';
let state = { students: [], trash: [] };
const today = new Date();
document.getElementById('today').textContent = today.toLocaleDateString();

function uid(){return 's_' + Math.random().toString(36).slice(2,9);}

function save(){
  localStorage.setItem(KEY, JSON.stringify(state));
  // Autosave removed: cloud writes only on Save Cloud or explicit calls.
}

function load(){ const raw = localStorage.getItem(KEY); if(raw) { try { state = JSON.parse(raw); } catch(e){ state = { students: [], trash: [] }; } } renderAll(); }

// Month helpers (unchanged)
function getMonthKey(d){ const dt = new Date(d); return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0'); }
function currentMonthKey(){ return getMonthKey(new Date()); }
function isPaidThisMonth(s){ const m = currentMonthKey(); return (s.payments || []).some(p => String(p.monthFor) === m); }
function shiftLabel(k){ if(k==='half-7-15') return 'Half A (7:00-15:00)'; if(k==='half-15-22') return 'Half B (15:00-22:00)'; return 'Full (7:00-22:00)'; }
function escapeHtml(s){ return (s||'').toString().replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }

function computeNextDue(student){
  let dueDay = 1;
  if(student.joinDate){
    const jd = new Date(student.joinDate);
    if(!isNaN(jd)) dueDay = jd.getDate() || 1;
  }
  const now = new Date();
  let candidate = new Date(now.getFullYear(), now.getMonth(), dueDay);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if(candidate < todayStart){
    let m = now.getMonth() + 1; let y = now.getFullYear(); if(m > 11){ m = 0; y += 1; } candidate = new Date(y, m, dueDay);
  }
  const diffDays = Math.ceil((candidate - todayStart) / (24*60*60*1000));
  const y = candidate.getFullYear(), mo = String(candidate.getMonth()+1).padStart(2,'0'), d = String(candidate.getDate()).padStart(2,'0');
  return { date: `${y}-${mo}-${d}`, daysLeft: diffDays };
}

// View switching
const nav = document.getElementById('sidebarNav');
nav.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-view]');
  if(!btn) return;
  const view = btn.getAttribute('data-view');
  switchView(view);
});
function switchView(viewName){
  nav.querySelectorAll('button[data-view]').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === viewName));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + viewName);
  if(target) target.classList.add('active');
  if(viewName === 'students') populateStudentsViewTable();
  if(viewName === 'reminders') populateRemindersView();
  if(viewName === 'payments') populatePaymentsView();
  if(viewName === 'dashboard') renderStats();
}

function renderAll(){ renderStats(); renderTable(); renderManager(); populateStudentsViewTable(); populateRemindersView(); populatePaymentsView(); }

function renderStats(){
  const totalStudents = state.students.length;
  const totalMonthly = state.students.reduce((a,s)=>a+(s.fee||0),0);
  const totalPaid = state.students.flatMap(s=>s.payments||[]).reduce((a,p)=>a+(p.amount||0),0);
  document.getElementById('statStudents').textContent = totalStudents;
  document.getElementById('statMonthly').textContent = '₹ '+totalMonthly;
  document.getElementById('statPaid').textContent = '₹ '+totalPaid;

  const countA = state.students.filter(s=>s.shift==='half-7-15').length;
  const countB = state.students.filter(s=>s.shift==='half-15-22').length;
  const countFull = state.students.filter(s=>s.shift==='full-7-22').length;
  document.getElementById('countA').textContent = countA;
  document.getElementById('countB').textContent = countB;
  document.getElementById('countFull').textContent = countFull;
  document.getElementById('countTotal').textContent = totalStudents;

  const rem = state.students.filter(s => (s.status || 'Active') === 'Active' && !isPaidThisMonth(s));
  document.getElementById('statReminders').textContent = rem.length;
  const remList = document.getElementById('reminderList');
  if(rem.length === 0) remList.textContent = 'No reminders today';
  else remList.textContent = rem.map(r => r.name + ' (' + shiftLabel(r.shift) + ')').join(', ');
}

function renderTable(){
  const tbody = document.querySelector('#studentsTable tbody'); tbody.innerHTML='';
  const q = (document.getElementById('q').value||'').toLowerCase();
  const fPaid = document.getElementById('filterPaid').value; const fShift = document.getElementById('filterShift').value;
  state.students.forEach(s=>{
    if(q && !(s.name.toLowerCase().includes(q) || (s.mobile||'').includes(q) || (s.parentMobile||'').includes(q))) return;
    if(fShift!=='all' && s.shift!==fShift) return;
    const paid = isPaidThisMonth(s);
    if(fPaid==='paid' && !paid) return; if(fPaid==='unpaid' && paid) return;

    const next = computeNextDue(s);
    const nextStr = next ? `${next.date} (${next.daysLeft}d)` : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${escapeHtml(s.name)}</strong><div style="color:var(--muted);font-size:12px">${escapeHtml(s.mobile||'')}</div></td>
      <td>${shiftLabel(s.shift)}</td>
      <td>₹ ${s.fee||0}</td>
      <td>${paid? '<span class="tag green">PAID</span>':'<span class="tag red">DUE</span>'}</td>
      <td>${nextStr}</td>
      <td>${s.joinDate||''}</td>
      <td style="text-align:right"><button class="btn small" data-act="collect" data-id="${s.id}">Collect</button> <button class="btn ghost small" data-act="view" data-id="${s.id}">View</button> <button class="btn ghost small" data-act="history" data-id="${s.id}">History</button> <button class="btn ghost small" data-act="remove" data-id="${s.id}">Trash</button></td>`;
    tbody.appendChild(tr);
  });
}

function renderManager(){ document.getElementById('trashCount').textContent = state.trash.length+' removed'; }

function populateStudentsViewTable(){
  const tbody = document.querySelector('#studentsTable_studentsView tbody'); if(!tbody) return; tbody.innerHTML = '';
  state.students.forEach(s => {
    const paid = isPaidThisMonth(s);
    const next = computeNextDue(s);
    const nextStr = next ? `${next.date} (${next.daysLeft}d)` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.mobile||'')}</td><td>${shiftLabel(s.shift)}</td><td>₹ ${s.fee||0}</td><td>${nextStr}</td><td>${paid? 'PAID':'DUE'}</td><td><button class="btn" data-id="${s.id}" data-act="view">View</button> <button class="btn ghost" data-id="${s.id}" data-act="collect">Collect</button></td>`;
    tbody.appendChild(tr);
  });
}

function populateRemindersView(){
  const container = document.getElementById('remindersListContainer'); if(!container) return;
  const list = state.students.filter(s => (s.status||'Active') === 'Active' && !isPaidThisMonth(s));
  if(list.length===0) { container.innerHTML = '<div class="small" style="color:var(--muted)">No reminders this month</div>'; return; }
  const html = list.map(s => {
    const last = (s.payments||[]).slice(-1)[0];
    return `<div style="padding:10px;border-bottom:1px solid #f2f4f8;display:flex;justify-content:space-between;align-items:center">
      <div><strong>${escapeHtml(s.name)}</strong><div class="small">${escapeHtml(s.mobile||'')}</div></div>
      <div style="text-align:right"><div class="small">Due: ₹ ${s.fee||0}</div><button class="btn" data-id="${s.id}" data-act="collect">Collect</button></div>
    </div>`;
  }).join('');
  container.innerHTML = html;
}

function populatePaymentsView(){
  const container = document.getElementById('paymentsListContainer'); if(!container) return;
  if(state.students.length===0){ container.innerHTML = '<div class="small" style="color:var(--muted)">No students / payments</div>'; return; }
  const html = state.students.map(s => {
    const total = (s.payments||[]).reduce((a,p)=>a+(p.amount||0),0);
    const last = (s.payments||[]).slice(-1)[0];
    const lastDate = last ? last.date.slice(0,10) : 'Never';
    return `<div style="padding:10px;border-bottom:1px solid #f4f6fb;display:flex;justify-content:space-between;align-items:center">
      <div><button class="btn ghost" onclick="openPaymentHistory('${s.id}')">${escapeHtml(s.name)}</button><div class="small" style="color:var(--muted)">${escapeHtml(s.mobile||'')}</div></div>
      <div style="text-align:right"><div style="font-weight:700">₹ ${total}</div><div class="small">${lastDate}</div></div>
    </div>`;
  }).join('');
  container.innerHTML = html;
}

// Event wiring
document.getElementById('addBtn').onclick = ()=>openStudentModal();
document.getElementById('exportBtn').onclick = ()=>exportData();
document.getElementById('importBtn').onclick = ()=>importData();
document.getElementById('q').addEventListener('input',renderTable);
document.getElementById('filterPaid').addEventListener('change',renderTable);
document.getElementById('filterShift').addEventListener('change',renderTable);
document.getElementById('monthlyReport').onclick = generateCSV;
document.getElementById('summaryReport').onclick = ()=>{ const m=currentMonthKey(); const total=state.students.length; const paid=state.students.filter(s=>(s.payments||[]).some(p=>p.monthFor===m)).length; const revenue=state.students.flatMap(s=>s.payments||[]).filter(p=>p.monthFor===m).reduce((a,p)=>a+p.amount,0); alert(`Summary ${m}:\nTotal students: ${total}\nPaid: ${paid}\nRevenue: ₹ ${revenue}`); };

document.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if(!b) return;
  const act = b.dataset.act; const id = b.dataset.id;
  if(act==='collect') openCollectModal(id);
  if(act==='view') openStudentModal(id, true);
  if(act==='history') openHistoryModal(id);
  if(act==='remove') { if(confirm('Move to trash?')) moveToTrash(id); }
});

// --- Modals & CRUD (unchanged logic) ---
function openStudentModal(id, readonly){
  const modal = document.createElement('div'); modal.className='modal-backdrop';
  const student = state.students.find(s=>s.id===id) || { id:null, name:'', mobile:'', parentMobile:'', aadhar:'', pan:'', shift:'half-7-15', fee:0, joinDate:'', payments:[], aadharData:'', status:'Active' };
  modal.innerHTML = `<div class="modal"><h3>${id? 'View / Edit Student':'Add Student'}</h3>
    <div style="margin-top:8px">
      <div class="form-row"><input id="m_name" placeholder="Full name" value="${escapeHtml(student.name||'')}" ${readonly? 'disabled':''} /><input id="m_mobile" placeholder="Mobile" value="${escapeHtml(student.mobile||'')}" ${readonly? 'disabled':''} /></div>
      <div class="form-row" style="margin-top:8px"><input id="m_parentMobile" placeholder="Parent mobile" value="${escapeHtml(student.parentMobile||'')}" ${readonly? 'disabled':''} /><input id="m_shift" ${readonly? 'disabled':''} /></div>
      <div class="form-row" style="margin-top:8px"><input id="m_fee" type="number" min="0" value="${student.fee||0}" ${readonly? 'disabled':''} /><input id="m_join" type="date" value="${student.joinDate||''}" ${readonly? 'disabled':''} /></div>
      <div class="form-row" style="margin-top:8px"><input id="m_aadhar" placeholder="Aadhar number" value="${escapeHtml(student.aadhar||'')}" ${readonly? 'disabled':''} /><input id="m_pan" placeholder="PAN" value="${escapeHtml(student.pan||'')}" ${readonly? 'disabled':''} /></div>

      <div class="form-row" style="margin-top:8px"><label style="font-size:13px;color:var(--muted)">Aadhar photo</label><input id="m_aadharPhoto" type="file" accept="image/*" ${readonly? 'disabled':''} /></div>
      <div id="aadharPreview" style="margin-top:8px"></div>

      <div style="margin-top:12px;text-align:right"><button class="btn" id="saveStudent">${readonly? 'Close':'Save'}</button> ${!readonly? '<button class="btn ghost" id="cancel">Cancel</button>':''}</div>
    </div></div>`;
  document.body.appendChild(modal);

  const shiftSelect = document.createElement('select'); shiftSelect.id = 'm_shift'; shiftSelect.innerHTML = '<option value="half-7-15">Half A (7-15)</option><option value="half-15-22">Half B (15-22)</option><option value="full-7-22">Full (7-22)</option>';
  const shiftInput = modal.querySelector('input#m_shift');
  shiftInput.replaceWith(shiftSelect);
  shiftSelect.value = student.shift || 'half-7-15';

  const preview = modal.querySelector('#aadharPreview');
  if(student.aadharData) preview.innerHTML = `<img src="${student.aadharData}" style="width:120px;border-radius:8px;border:1px solid #eee">`;

  const fileInput = modal.querySelector('#m_aadharPhoto');
  fileInput.onchange = (ev) => {
    const f = ev.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = e => { modal._aadharData = e.target.result; preview.innerHTML = `<img src="${e.target.result}" style="width:120px;border-radius:8px;border:1px solid #eee">`; };
    reader.readAsDataURL(f);
  };

  modal.querySelector('#saveStudent').onclick = () => {
    if(readonly){ modal.remove(); return; }
    const name = modal.querySelector('#m_name').value.trim(); if(!name) return alert('Enter name');
    const data = {
      id: student.id || uid(),
      name,
      mobile: modal.querySelector('#m_mobile').value.trim(),
      parentMobile: modal.querySelector('#m_parentMobile').value.trim(),
      shift: modal.querySelector('#m_shift').value,
      fee: Number(modal.querySelector('#m_fee').value||0),
      joinDate: modal.querySelector('#m_join').value||'',
      aadhar: modal.querySelector('#m_aadhar').value.trim(),
      pan: modal.querySelector('#m_pan').value.trim(),
      aadharData: modal._aadharData || student.aadharData || '',
      payments: student.payments || [],
      status: student.status || 'Active'
    };
    const idx = state.students.findIndex(s=>s.id===data.id);
    if(idx===-1) state.students.push(data); else state.students[idx]=data;
    save(); renderAll(); modal.remove();

    // explicit cloud write for this saved student if signed in
    if(firebaseReady && currentUser) {
      saveStudentToFirestore(data).catch(e => console.warn('saveStudentToFirestore error', e));
    }
  };

  const c = modal.querySelector('#cancel'); if(c) c.onclick = ()=>modal.remove();
}

function openCollectModal(id){
  const s = state.students.find(x=>x.id===id); if(!s) return;
  const modal = document.createElement('div'); modal.className='modal-backdrop';
  const defaultMonth = currentMonthKey();
  modal.innerHTML = `<div class="modal"><h3>Collect fee — ${escapeHtml(s.name)}</h3><div style="margin-top:8px">
    <div class="form-row"><input id="amt" type="number" value="${s.fee||0}" /></div>
    <div class="form-row" style="margin-top:8px"><label style="font-size:13px;color:var(--muted)">For Month</label><input id="monthFor" type="month" value="${defaultMonth}" /></div>
    <div style="margin-top:10px;text-align:right"><button class="btn" id="do">Record</button> <button class="btn ghost" id="c">Cancel</button></div>
  </div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#do').onclick = ()=>{
    const a = Number(modal.querySelector('#amt').value||0);
    const mRaw = modal.querySelector('#monthFor').value;
    const monthFor = mRaw && mRaw.includes('-') ? mRaw.slice(0,7) : currentMonthKey();
    s.payments = s.payments || [];
    s.payments.push({ id: 'p_' + Date.now(), date: new Date().toISOString(), amount: a, monthFor: monthFor, method: 'Cash' });
    save(); renderAll(); modal.remove();

    if(firebaseReady && currentUser) {
      saveStudentToFirestore(s).catch(e => console.warn('save payment to FS failed', e));
    }
  };
  modal.querySelector('#c').onclick = ()=>modal.remove();
}

function openPaymentHistory(studentId){
  const s = state.students.find(x=>x.id===studentId);
  if(!s) return alert('Student not found');

  const modal = document.createElement('div'); modal.className='modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">Payments — ${escapeHtml(s.name)}</h3>
        <div><button class="btn ghost" id="phClose">Close</button></div>
      </div>

      <div style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div><strong>Payment history</strong></div>
          <input id="phSearchBox" placeholder="Search month/date/amount" style="padding:6px;border-radius:6px;border:1px solid rgba(0,0,0,0.04)" />
        </div>

        <div style="max-height:400px;overflow:auto">
          <table style="width:100%"><thead><tr><th>Date</th><th>Month</th><th>Amount</th><th>Method</th><th></th></tr></thead>
            <tbody id="phTableBody"></tbody></table>
        </div>

      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#phClose').onclick = ()=>modal.remove();

  function build(){
    const q = (modal.querySelector('#phSearchBox').value||'').toLowerCase();
    const tbody = modal.querySelector('#phTableBody'); tbody.innerHTML = '';
    (s.payments||[]).slice().reverse().forEach(p=>{
      const text = `${p.date||''} ${p.monthFor||''} ${p.amount||''} ${p.method||''}`.toLowerCase();
      if(q && !text.includes(q)) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.date? p.date.slice(0,10):''}</td><td>${p.monthFor||''}</td><td>₹ ${p.amount||0}</td><td>${escapeHtml(p.method||'')}</td><td><button class="btn ghost" data-pid="${p.id}">Delete</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('button[data-pid]').forEach(b=>{
      b.onclick = ()=>{
        if(!confirm('Delete this payment?')) return;
        const pid = b.dataset.pid;
        s.payments = (s.payments||[]).filter(x=>x.id!==pid);
        save(); build(); renderAll();
      };
    });
  }

  modal.querySelector('#phSearchBox').addEventListener('input', build);
  build();
}

function openHistoryModal(id){ openPaymentHistory(id); }
function moveToTrash(id){ const idx = state.students.findIndex(s=>s.id===id); if(idx===-1) return; const [r]=state.students.splice(idx,1); r._removedAt=new Date().toISOString(); state.trash.push(r); save(); renderAll(); }
function openTrash(){ const modal=document.createElement('div'); modal.className='modal-backdrop'; modal.innerHTML = `<div class="modal"><h3>Trash</h3><div id="trashContent" style="max-height:400px;overflow:auto;margin-top:8px"></div><div style="text-align:right;margin-top:12px"><button class="btn ghost" id="closeT">Close</button></div></div>`; document.body.appendChild(modal); const box=modal.querySelector('#trashContent'); if(state.trash.length===0) box.innerHTML='<div style="color:var(--muted)">Empty</div>'; else state.trash.forEach(t=>{ const el=document.createElement('div'); el.style.padding='8px'; el.style.borderBottom='1px solid #f4f6fb'; el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><div><strong>${escapeHtml(t.name)}</strong><div style="color:var(--muted);font-size:13px">Removed: ${t._removedAt?.slice(0,10)||''}</div></div><div><button class="btn" data-r="${t.id}">Restore</button> <button class="btn ghost" data-d="${t.id}">Delete</button></div></div>`; box.appendChild(el); }); box.querySelectorAll('button[data-r]').forEach(b=>b.onclick=()=>{ const id=b.dataset.r; const i=state.trash.findIndex(x=>x.id===id); if(i>-1){ const [it]=state.trash.splice(i,1); delete it._removedAt; state.students.push(it); save(); modal.remove(); renderAll(); openTrash(); }}); box.querySelectorAll('button[data-d]').forEach(b=>b.onclick=()=>{ if(confirm('Delete permanently?')){ const id=b.dataset.d; const i=state.trash.findIndex(x=>x.id===id); if(i>-1){ state.trash.splice(i,1); save(); modal.remove(); renderAll(); openTrash(); } } }); modal.querySelector('#closeT').onclick=()=>modal.remove(); }

// Export/import & reports
function exportData(){ const data=JSON.stringify(state,null,2); const blob=new Blob([data],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='lab-data.json'; a.click(); URL.revokeObjectURL(url); }
function importData(){ const inp=document.createElement('input'); inp.type='file'; inp.accept='application/json'; inp.onchange=e=>{ const f=e.target.files[0]; const r=new FileReader(); r.onload=()=>{ try{ state=JSON.parse(r.result); save(); renderAll(); alert('Imported'); }catch(err){ alert('Invalid JSON') } }; r.readAsText(f); }; inp.click(); }
function generateCSV(){ const rows=[['Name','Shift','Fee','Status','Last payment','ParentMobile']]; const m = currentMonthKey(); state.students.forEach(s=>{ const paid = (s.payments||[]).some(p=>p.monthFor===m); const last=(s.payments||[]).slice(-1)[0]; rows.push([s.name, shiftLabel(s.shift), s.fee, paid? 'PAID':'DUE', last? last.date.slice(0,10):'', s.parentMobile||'']); }); const csv = rows.map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n'); const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='lab-report-'+currentMonthKey()+'.csv'; a.click(); URL.revokeObjectURL(url); }

document.getElementById('collectAll').onclick = ()=>{ const rem = state.students.filter(s=> (s.status||'Active')==='Active' && !isPaidThisMonth(s)); if(rem.length===0) return alert('No reminders today'); let i=0; const next=()=>{ if(i>=rem.length) return alert('Done'); openCollectModal(rem[i++].id); }; next(); };

document.getElementById('openTrash').onclick = openTrash;

// initial load
load();
// default view
switchView('dashboard');

// ============================
// UI: Firebase button handlers
// ============================

// Sign-in modal (SIGN IN only)
function createSignInModal() {
  if (document.getElementById('authModal')) {
    document.getElementById('authModal').style.display = 'flex';
    return;
  }
  const modal = document.createElement('div'); modal.id = 'authModal'; modal.className = 'modal-backdrop'; modal.style.zIndex = 10005;
  modal.innerHTML = `
    <div class="modal" style="width:420px;max-width:92%">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">Sign in</h3>
        <button id="authClose" class="btn ghost">Close</button>
      </div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:8px">
          <button id="authGoogle" class="btn" style="flex:1">Sign in with Google</button>
          <button id="authEmailToggle" class="btn ghost" style="flex:1">Email</button>
        </div>

        <div id="emailArea" style="display:none;flex-direction:column;gap:8px">
          <input id="authEmail" placeholder="Email" style="padding:10px;border-radius:8px;border:1px solid #e6e9f0" />
          <input id="authPass" placeholder="Password" type="password" style="padding:10px;border-radius:8px;border:1px solid #e6e9f0" />
          <div style="display:flex;gap:8px">
            <button id="emailSignIn" class="btn" style="flex:1">Sign in</button>
            <button id="emailForgot" class="btn ghost" style="flex:1">Forgot?</button>
          </div>
          <div style="font-size:13px;color:var(--muted);margin-top:6px">Use the email/password account you created in Firebase Console.</div>
        </div>

        <div id="authMsg" style="font-size:13px;color:var(--muted)"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#authClose').onclick = () => modal.remove();

  modal.querySelector('#authGoogle').onclick = async () => {
    if(!firebaseReady) return alert('Firebase not initialized');
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
      modal.remove();
    } catch(e) {
      console.error('Google sign-in error', e);
      modal.querySelector('#authMsg').textContent = 'Google sign-in failed: ' + (e.message||e);
    }
  };

  const emailToggle = modal.querySelector('#authEmailToggle');
  const emailArea = modal.querySelector('#emailArea');
  emailToggle.onclick = () => { emailArea.style.display = emailArea.style.display === 'flex' ? 'none' : 'flex'; };

  modal.querySelector('#emailSignIn').onclick = async () => {
    const em = modal.querySelector('#authEmail').value.trim();
    const pw = modal.querySelector('#authPass').value;
    if(!em || !pw) return alert('Enter email and password');
    try {
      await auth.signInWithEmailAndPassword(em, pw);
      modal.remove();
    } catch(e) {
      console.error('Email sign-in error', e);
      modal.querySelector('#authMsg').textContent = 'Sign-in failed: ' + (e.message||e);
    }
  };

  modal.querySelector('#emailForgot').onclick = async () => {
    const em = modal.querySelector('#authEmail').value.trim();
    if(!em) return alert('Enter email to reset password');
    try {
      await auth.sendPasswordResetEmail(em);
      modal.querySelector('#authMsg').textContent = 'Password reset email sent.';
    } catch(e) {
      console.error('Forgot password error', e);
      modal.querySelector('#authMsg').textContent = 'Reset failed: ' + (e.message||e);
    }
  };
}

document.getElementById('btnAuth').onclick = async function() {
  if(!firebaseReady) {
    initFirebaseIfPossible();
    if(!firebaseReady) return alert('Firebase not initialized. Paste firebaseConfig in code.');
  }
  if(currentUser) {
    if(!confirm('Sign out?')) return;
    try { await auth.signOut(); alert('Signed out'); } catch(e){ console.error(e); alert('Sign-out failed'); }
    return;
  }
  createSignInModal();
};

// Save Cloud button
document.getElementById('btnSaveCloud').onclick = async function() {
  if(!firebaseReady) {
    initFirebaseIfPossible();
    if(!firebaseReady) return alert('Firebase not initialized. Paste firebaseConfig.');
  }
  if(!currentUser) return alert('Sign in first to save to cloud.');
  if(!confirm('Push local data to Cloud? This will merge local students into Cloud.')) return;
  try {
    await saveAllToFirestore();
    alert('Saved to cloud ✅');
  } catch(e) {
    console.error(e);
    alert('Save failed: ' + (e.message||e));
  }
};

// Load Cloud button
document.getElementById('btnLoadCloud').onclick = async function() {
  if(!firebaseReady) {
    initFirebaseIfPossible();
    if(!firebaseReady) return alert('Firebase not initialized. Paste firebaseConfig.');
  }
  if(!currentUser) return alert('Sign in first to load from cloud.');
  if(!confirm('Load from cloud and merge with local data? Cloud entries will overwrite local entries with same ID.')) return;
  await loadFromFirestore();
};

// Initialize Firebase attempt
initFirebaseIfPossible();

// ===========================
// Mobile sidebar: overlay behavior
// ===========================
(function(){
  const menuBtn = document.getElementById('menuBtn');
  const sidebar = document.querySelector('.sidebar');
  const sidebarCloseBtn = document.getElementById('sidebarClose');

  if(!menuBtn || !sidebar) {
    console.warn('Mobile sidebar: required elements not found (menuBtn or sidebar).');
    return;
  }

  let backdrop = document.querySelector('.sidebar-backdrop');
  if(!backdrop){
    backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
  }

  function openSidebar() {
    sidebar.classList.add('open');
    backdrop.classList.add('show');
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    setTimeout(()=> {
      const firstBtn = sidebar.querySelector('button, a, input, [tabindex]');
      if(firstBtn) firstBtn.focus();
    }, 180);
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('show');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    try { menuBtn.focus(); } catch(e){}
  }

  menuBtn.addEventListener('click', () => {
    if(sidebar.classList.contains('open')) closeSidebar(); else openSidebar();
  });

  backdrop.addEventListener('click', closeSidebar);
  if(sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);
  sidebar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-view]');
    if(btn) { setTimeout(closeSidebar, 160); }
  });

  document.addEventListener('keydown', (ev) => {
    if(ev.key === 'Escape' && sidebar.classList.contains('open')) closeSidebar();
  });

  window.addEventListener('resize', () => {
    if(window.innerWidth > 980 && sidebar.classList.contains('open')) closeSidebar();
  });
})();
// === Ensure only one view shows and re-hook sidebar nav clicks ===
(function ensureSingleActiveView() {
  // fix: if some views accidentally had "active" set multiple times, normalize
  const views = Array.from(document.querySelectorAll('.view'));
  if (views.length === 0) return; // nothing to do

  // Remove extra .active flags, keep only dashboard if multiple active
  const activeViews = views.filter(v => v.classList.contains('active'));
  if (activeViews.length === 0) {
    // nothing active — show dashboard by default
    const dash = document.getElementById('view-dashboard');
    if (dash) dash.classList.add('active');
  } else if (activeViews.length > 1) {
    // multiple active: clear all and activate dashboard (or first active)
    views.forEach(v => v.classList.remove('active'));
    const dash = document.getElementById('view-dashboard') || views[0];
    dash.classList.add('active');
  }

  // Re-hook navigation buttons to ensure switchView is used
  const sidebarNav = document.getElementById('sidebarNav');
  if (sidebarNav) {
    // remove existing listeners by cloning (safe) then re-attach a single handler
    const navClone = sidebarNav.cloneNode(true);
    sidebarNav.parentNode.replaceChild(navClone, sidebarNav);

    navClone.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-view]');
      if (!btn) return;
      // highlight nav button
      navClone.querySelectorAll('button[data-view]').forEach(b => b.classList.toggle('active', b === btn));
      // hide all views and show the requested one
      const viewName = btn.getAttribute('data-view');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const target = document.getElementById('view-' + viewName);
      if (target) target.classList.add('active');
      // preserve any existing function you rely on:
      if (typeof switchView === 'function') {
        try { switchView(viewName); } catch(e) { /* ignore if not usable */ }
      }
      // scroll top on small screens for UX
      window.scrollTo(0,0);
    });
  }

  // Finally ensure dashboard active (explicit)
  const dash = document.getElementById('view-dashboard');
  if (dash) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    dash.classList.add('active');
  }
})();

// End of app.js
