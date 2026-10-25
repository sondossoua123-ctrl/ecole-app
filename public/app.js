const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('t'), me = JSON.parse(localStorage.getItem('u') || 'null'), rows = {};

async function api(p, m = 'GET', b) {
  const r = await fetch('/api/' + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (r.status === 401 && token) { logout(); throw new Error('Session expirée'); }
  if (!r.ok) throw new Error(j.error || (typeof j === 'string' ? j : 'Erreur'));
  return j;
}
const ALL = ['admin', 'teacher', 'parent', 'student', 'accountant'];
const ROLE_FR = { admin: 'Administrateur', teacher: 'Enseignant', parent: 'Parent', student: 'Élève', accountant: 'Comptable' };
const LBL = { users: o => o.name, classes: o => o.niveau + ' ' + (o.section || ''), subjects: o => o.nom, students: o => o.prenom + ' ' + o.nom };
const COLL = { classe: 'classes', parent: 'users', user: 'users', titulaire: 'users', student: 'students', subject: 'subjects' };
const ENT = {
  users: { t: 'Utilisateurs', w: ['admin'], cols: ['name', 'email', 'role'], f: [['name', 'Nom complet'], ['email', 'Email', 'email'], ['role', 'Rôle', 'sel:admin,teacher,parent,student,accountant'], ['password', 'Mot de passe (vide = inchangé)', 'password']] },
  classes: { t: 'Classes', w: ['admin'], cols: ['niveau', 'section', 'capacite', 'titulaire', 'annee_scolaire'], f: [['niveau', 'Niveau (CP, CE1…)'], ['section', 'Section'], ['capacite', 'Capacité maximale', 'number'], ['titulaire', 'Enseignant titulaire', 'ref:users:teacher'], ['annee_scolaire', 'Année scolaire']] },
  subjects: { t: 'Matières', w: ['admin'], cols: ['nom', 'coefficient', 'niveau'], f: [['nom', 'Nom'], ['coefficient', 'Coefficient', 'number'], ['niveau', 'Niveau concerné']] },
  students: { t: 'Élèves', w: ['admin'], cols: ['prenom', 'nom', 'classe', 'parent', 'scolarite'], f: [['nom', 'Nom'], ['prenom', 'Prénom'], ['dateNaissance', 'Date de naissance', 'date'], ['classe', 'Classe', 'ref:classes'], ['parent', 'Parent / tuteur', 'ref:users:parent'], ['user', 'Compte élève', 'ref:users:student'], ['scolarite', 'Scolarité due (DT)', 'number'], ['medical', 'Antécédents médicaux', 'textarea'], ['annee_scolaire', 'Année scolaire']] },
  grades: { t: 'Notes', w: ['admin', 'teacher'], cols: ['student', 'subject', 'valeur', 'type', 'trimestre'], f: [['student', 'Élève', 'ref:students'], ['subject', 'Matière', 'ref:subjects'], ['valeur', 'Note sur 20', 'number'], ['type', 'Type', 'sel:Contrôle continu,Examen trimestriel'], ['trimestre', 'Trimestre', 'sel:1,2,3'], ['commentaire', 'Commentaire'], ['annee_scolaire', 'Année scolaire']] },
  payments: { t: 'Paiements', w: ['admin', 'accountant'], cols: ['student', 'montant', 'mode', 'motif', 'date'], f: [['student', 'Élève', 'ref:students'], ['montant', 'Montant (DT)', 'number'], ['mode', 'Mode', 'sel:Espèces,Virement,Mobile money'], ['motif', 'Motif'], ['date', 'Date', 'date'], ['annee_scolaire', 'Année scolaire']] },
  homework: { t: 'Devoirs', w: ['admin', 'teacher'], cols: ['titre', 'classe', 'subject', 'dateRemise'], f: [['titre', 'Titre'], ['description', 'Description', 'textarea'], ['classe', 'Classe', 'ref:classes'], ['subject', 'Matière', 'ref:subjects'], ['dateRemise', 'Date de remise', 'date']] }
};
const MENU = {
  admin: ['users', 'classes', 'subjects', 'students', 'grades', 'payments', 'homework', 'messages', 'announce'],
  teacher: ['students', 'grades', 'homework', 'classes', 'subjects', 'messages'],
  parent: ['students', 'grades', 'payments', 'homework', 'messages'],
  student: ['grades', 'homework', 'messages'],
  accountant: ['students', 'payments', 'messages']
};
const NAMES = { messages: 'Messagerie', announce: 'Annonces' };
const title = k => NAMES[k] || ENT[k].t;

/* ----- Connexion ----- */
$('#lf').onsubmit = async e => {
  e.preventDefault(); $('#le').textContent = '';
  try {
    const r = await api('login', 'POST', { email: $('#em').value, password: $('#pw').value });
    token = r.token; me = r.user; localStorage.setItem('t', token); localStorage.setItem('u', JSON.stringify(me)); start();
  } catch (err) { $('#le').textContent = err.message; }
};
function logout() { localStorage.clear(); token = me = null; $('#app').hidden = true; $('#login').hidden = false; }
$('#lo').onclick = logout;
function start() {
  if (!token || !me) return logout();
  $('#login').hidden = true; $('#app').hidden = false;
  $('#who').textContent = me.name + ' (' + ROLE_FR[me.role] + ')';
  $('#nav').innerHTML = MENU[me.role].map(k => `<button data-nav="${k}">${title(k)}</button>`).join('');
  show(MENU[me.role][0]);
}
$('#nav').onclick = e => { const k = e.target.dataset.nav; if (k) show(k); };

/* ----- Tableaux CRUD ----- */
function cell(k, v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object') return esc(LBL[COLL[k]](v));
  if (/^date/i.test(k)) return new Date(v).toLocaleDateString('fr-FR');
  if (k === 'role') return ROLE_FR[v] || v;
  return esc(v);
}
async function show(k) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === k));
  try {
    if (k === 'messages') return msgs('in');
    if (k === 'announce') return announce();
    const E = ENT[k], data = await api(k), w = E.w.includes(me.role);
    rows[k] = data;
    const head = E.cols.map(c => `<th>${esc(E.f.find(f => f[0] === c)?.[1] || c)}</th>`).join('');
    const body = data.map(r => `<tr>${E.cols.map(c => `<td>${cell(c, r[c])}</td>`).join('')}<td class="act">
      ${k === 'students' && me.role !== 'accountant' ? `<button class="sec" data-a="bul" data-id="${r._id}">Bulletin</button>` : ''}
      ${k === 'payments' ? `<button class="sec" data-a="rec" data-id="${r._id}">Reçu</button>` : ''}
      ${w ? `<button class="sec" data-a="edit" data-k="${k}" data-id="${r._id}">Modifier</button><button class="del" data-a="del" data-k="${k}" data-id="${r._id}">Supprimer</button>` : ''}</td></tr>`).join('');
    $('#main').innerHTML = `<h2>${E.t}</h2>${w ? `<button data-a="add" data-k="${k}">Ajouter</button>` : ''}
      <div class="scroll"><table><tr>${head}<th></th></tr>${body || `<tr><td colspan="${E.cols.length + 1}">Aucun enregistrement.</td></tr>`}</table></div>`;
  } catch (err) { $('#main').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}
async function openHtml(path) {
  try { const h = await api(path), w = window.open('', '_blank'); w.document.write(h); w.document.close(); } catch (e) { alert(e.message); }
}
$('#main').onclick = async e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const { a, k, id } = b.dataset;
  if (a === 'add') return form(k);
  if (a === 'edit') return form(k, rows[k].find(r => r._id === id));
  if (a === 'bul') return openHtml('bulletin/' + id);
  if (a === 'rec') return openHtml('payments/' + id + '/receipt');
  if (a === 'del' && confirm('Supprimer cet enregistrement ?')) { try { await api(k + '/' + id, 'DELETE'); show(k); } catch (err) { alert(err.message); } }
  if (a === 'box') return msgs(id);
  if (a === 'hide') { await api('messages/' + id + '/hide', 'PUT'); msgs('in'); }
};

/* ----- Formulaire ajout / modification ----- */
async function form(k, row) {
  const E = ENT[k]; let h = `<h3>${row ? 'Modifier' : 'Ajouter'} – ${E.t}</h3>`;
  for (const [n, l, ty = 'text'] of E.f) {
    let v = row?.[n]; if (v && typeof v === 'object') v = v._id;
    if (ty.startsWith('ref:')) {
      const [, c, role] = ty.split(':'); const list = (await api(c)).filter(x => !role || x.role === role);
      h += `<label>${l}<select name="${n}"><option value="">—</option>${list.map(x => `<option value="${x._id}" ${x._id === v ? 'selected' : ''}>${esc(LBL[c](x))}</option>`).join('')}</select></label>`;
    } else if (ty.startsWith('sel:')) {
      h += `<label>${l}<select name="${n}">${ty.slice(4).split(',').map(o => `<option ${String(v) === o ? 'selected' : ''} value="${o}">${ROLE_FR[o] || o}</option>`).join('')}</select></label>`;
    } else if (ty === 'textarea') h += `<label>${l}<textarea name="${n}" rows="3">${esc(v)}</textarea></label>`;
    else if (ty === 'date') h += `<label>${l}<input type="date" name="${n}" value="${v ? String(v).slice(0, 10) : ''}"></label>`;
    else h += `<label>${l}<input type="${ty}" name="${n}" ${ty === 'number' ? 'step="any"' : ''} value="${ty === 'password' ? '' : esc(v)}"></label>`;
  }
  h += `<p class="err" id="fe"></p><div class="row"><button type="button" class="sec" id="cx">Annuler</button><button>Enregistrer</button></div>`;
  $('#df').innerHTML = h; $('#dlg').showModal();
  $('#cx').onclick = () => $('#dlg').close();
  $('#df').onsubmit = async e => {
    e.preventDefault();
    const body = {}; new FormData($('#df')).forEach((v, n) => { body[n] = v; });
    try { await api(row ? k + '/' + row._id : k, row ? 'PUT' : 'POST', body); $('#dlg').close(); show(k); }
    catch (err) { $('#fe').textContent = err.message; }
  };
}

/* ----- Messagerie ----- */
async function msgs(box) {
  const [list, contacts] = await Promise.all([api('messages?box=' + box), api('contacts')]);
  $('#main').innerHTML = `<h2>Messagerie</h2>
  <details><summary><b>Nouveau message</b></summary><form id="mf">
    <label>Destinataire<select name="to" required>${contacts.map(c => `<option value="${c._id}">${esc(c.name)} (${ROLE_FR[c.role]})</option>`).join('')}</select></label>
    <label>Objet<input name="objet" required></label><label>Message<textarea name="corps" rows="4" required></textarea></label>
    <p class="err" id="fe"></p><div class="row"><button>Envoyer</button></div></form></details>
  <div class="tabs"><button class="${box === 'in' ? '' : 'sec'}" data-a="box" data-id="in">Reçus</button><button class="${box === 'out' ? '' : 'sec'}" data-a="box" data-id="out">Envoyés</button></div>
  ${list.map(m => `<div class="msg"><b>${esc(m.objet)}</b><small>${box === 'in' ? 'De : ' + esc(m.from?.name) : 'À : ' + esc(m.to?.name)} – ${new Date(m.createdAt).toLocaleString('fr-FR')}</small><p>${esc(m.corps)}</p>${box === 'in' ? `<button class="sec" data-a="hide" data-id="${m._id}">Masquer</button>` : ''}</div>`).join('') || '<p>Aucun message.</p>'}`;
  $('#mf').onsubmit = async e => {
    e.preventDefault(); const b = {}; new FormData($('#mf')).forEach((v, n) => { b[n] = v; });
    try { await api('messages', 'POST', b); msgs('out'); } catch (err) { $('#fe').textContent = err.message; }
  };
}

/* ----- Annonces (admin) ----- */
function announce() {
  $('#main').innerHTML = `<h2>Annonces générales</h2><p>Une annonce publiée ne peut plus être modifiée ni supprimée : publiez une annonce corrective en cas d’erreur.</p>
  <form id="af"><div class="checks">${ALL.map(r => `<label><input type="checkbox" name="roles" value="${r}" checked>${ROLE_FR[r]}</label>`).join('')}</div>
  <label>Objet<input name="objet" required></label><label>Texte<textarea name="corps" rows="5" required></textarea></label>
  <p class="err" id="fe"></p><div class="row"><button>Publier l’annonce</button></div></form>`;
  $('#af').onsubmit = async e => {
    e.preventDefault(); const f = new FormData($('#af'));
    try { const r = await api('announce', 'POST', { roles: f.getAll('roles'), objet: f.get('objet'), corps: f.get('corps') }); $('#fe').style.color = 'green'; $('#fe').textContent = 'Annonce envoyée à ' + r.envoyes + ' utilisateur(s).'; $('#af').reset(); }
    catch (err) { $('#fe').textContent = err.message; }
  };
}
start();
