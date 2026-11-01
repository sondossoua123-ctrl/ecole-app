// Test automatique d'isolation entre écoles (École A / École B).
// Lancer le serveur, puis :  node test-isolation.js
// Autre adresse :  $env:BASE_URL="https://ecole-app-66fm.onrender.com"; node test-isolation.js
require('dotenv').config();
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SA = { email: process.env.SUPERADMIN_EMAIL || 'superadmin@saas.tn', password: process.env.SUPERADMIN_PASSWORD || 'Super1234' };
let fails = 0;
const ok = (name, cond) => { console.log((cond ? '  ✔ ' : '  ✘ ') + name); if (!cond) fails++; };

async function call(token, method, path, body) {
  const r = await fetch(BASE + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
}
async function login(email, password) {
  const r = await call(null, 'POST', 'login', { email, password });
  if (r.status !== 200) throw new Error('Connexion impossible (' + email + ') : ' + JSON.stringify(r.data));
  return r.data.token;
}

async function setup(sa, L) {
  const stamp = Date.now(), l = L.toLowerCase();
  const adminEmail = `admin-${l}-${stamp}@test.tn`, parentEmail = `parent-${l}-${stamp}@test.tn`;
  let r = await call(sa, 'POST', 'schools', { name: `Ecole ${L} ${stamp}`, adminName: `Directeur ${L}`, adminEmail, adminPassword: 'Test1234' });
  if (r.status !== 200) throw new Error('Création école ' + L + ' : ' + JSON.stringify(r.data));
  const schoolId = r.data.id, admin = await login(adminEmail, 'Test1234');
  await call(admin, 'POST', 'users', { name: `Parent ${L}`, email: parentEmail, role: 'parent', password: 'Test1234' });
  await call(admin, 'POST', 'users', { name: `Prof ${L}`, email: `prof-${l}-${stamp}@test.tn`, role: 'teacher', password: 'Test1234' });
  const users = (await call(admin, 'GET', 'users')).data;
  const parent = users.find(u => u.email === parentEmail), adminUser = users.find(u => u.email === adminEmail);
  await call(admin, 'POST', 'classes', { niveau: 'CE1', section: L, capacite: 25 });
  const cls = (await call(admin, 'GET', 'classes')).data[0];
  await call(admin, 'POST', 'subjects', { nom: 'Maths', coefficient: 2 });
  const subj = (await call(admin, 'GET', 'subjects')).data[0];
  for (let i = 1; i <= 5; i++) await call(admin, 'POST', 'students', { nom: `${L}-Eleve${i}`, prenom: 'Test', classe: cls._id, parent: i === 1 ? parent._id : '', scolarite: 1000 });
  const students = (await call(admin, 'GET', 'students')).data, s1 = students.find(s => s.nom === `${L}-Eleve1`);
  await call(admin, 'POST', 'grades', { student: s1._id, subject: subj._id, valeur: 15 });
  await call(admin, 'POST', 'payments', { student: s1._id, montant: 100, mode: 'Espèces' });
  const pay = (await call(admin, 'GET', 'payments')).data[0];
  return { L, schoolId, admin, adminId: adminUser._id, parent, parentEmail, cls, subj, s1, pay };
}

async function cross(X, Y) {
  const t = `${X.L} → ${Y.L} : `;
  console.log(`\nÉcole ${X.L} essaie d'accéder aux données de l'école ${Y.L}`);
  const list = (await call(X.admin, 'GET', 'students')).data;
  ok(t + 'la liste des élèves ne contient que son école', list.length === 5 && list.every(s => s.nom.startsWith(X.L + '-')));
  let r = await call(X.admin, 'PUT', 'students/' + Y.s1._id, { nom: 'HACK' });
  ok(t + 'modifier un élève de l’autre école : refusé', r.status === 404);
  r = await call(X.admin, 'DELETE', 'students/' + Y.s1._id);
  ok(t + 'supprimer un élève de l’autre école : refusé', r.status === 404);
  r = await call(X.admin, 'PUT', 'payments/' + Y.pay._id, { montant: 1 });
  ok(t + 'modifier un paiement de l’autre école : refusé', r.status === 404);
  r = await call(X.admin, 'GET', 'bulletin/' + Y.s1._id);
  ok(t + 'bulletin d’un élève de l’autre école : refusé', r.status !== 200);
  r = await call(X.admin, 'GET', 'payments/' + Y.pay._id + '/receipt');
  ok(t + 'reçu d’un paiement de l’autre école : refusé', r.status !== 200);
  r = await call(X.admin, 'POST', 'grades', { student: Y.s1._id, subject: X.subj._id, valeur: 10 });
  ok(t + 'ajouter une note à un élève de l’autre école : refusé', r.status !== 200);
  r = await call(X.admin, 'POST', 'students', { nom: 'X', prenom: 'X', classe: Y.cls._id });
  ok(t + 'utiliser une classe de l’autre école : refusé', r.status !== 200);
  await call(X.admin, 'POST', 'classes', { niveau: 'HACK-' + X.L, schoolId: Y.schoolId });
  const yc = (await call(Y.admin, 'GET', 'classes')).data;
  ok(t + 'envoyer un schoolId dans le formulaire n’a aucun effet', !yc.some(c => c.niveau === 'HACK-' + X.L));
  const contacts = (await call(X.admin, 'GET', 'contacts')).data;
  ok(t + 'contacts de la messagerie : uniquement son école', Array.isArray(contacts) && !contacts.some(c => c.name === `Directeur ${Y.L}` || c.name === `Parent ${Y.L}`));
  r = await call(X.admin, 'POST', 'messages', { to: Y.adminId, objet: 'a', corps: 'b' });
  ok(t + 'écrire à un utilisateur de l’autre école : refusé', r.status === 403);
  r = await call(X.admin, 'POST', 'announce', { objet: 'Annonce-test-' + X.L, corps: 'x' });
  const inbox = (await call(Y.admin, 'GET', 'messages?box=in')).data;
  ok(t + 'une annonce n’arrive pas dans l’autre école', r.status === 200 && !inbox.some(m => (m.objet || '').includes('Annonce-test-' + X.L)));
  const pt = await login(X.parentEmail, 'Test1234');
  const mine = (await call(pt, 'GET', 'students')).data;
  ok(t + 'le parent ne voit que son propre enfant', mine.length === 1 && mine[0].nom === X.L + '-Eleve1');
  r = await call(pt, 'GET', 'bulletin/' + Y.s1._id);
  ok(t + 'le parent ne peut pas ouvrir le bulletin de l’autre école', r.status !== 200);
}

(async () => {
  const sa = await login(SA.email, SA.password);
  const A = await setup(sa, 'A'), B = await setup(sa, 'B');
  console.log('Écoles de test créées : A et B (5 élèves chacune)');
  await cross(A, B);
  await cross(B, A);

  console.log('\nSuper-administrateur et suspension');
  let r = await call(sa, 'GET', 'students');
  ok('le super-administrateur n’accède pas aux données d’une école', r.status === 403);
  await call(sa, 'PUT', 'schools/' + A.schoolId, { status: 'suspended' });
  r = await call(null, 'POST', 'login', { email: A.parentEmail, password: 'Test1234' });
  ok('école suspendue : connexion refusée', r.status === 403);
  r = await call(A.admin, 'GET', 'students');
  ok('école suspendue : le jeton déjà émis est refusé aussi', r.status === 403);
  await call(sa, 'PUT', 'schools/' + A.schoolId, { status: 'active' });
  r = await call(null, 'POST', 'login', { email: A.parentEmail, password: 'Test1234' });
  ok('école réactivée : connexion acceptée', r.status === 200);

  // nettoyage : les écoles de test sont supprimées (suppression logique)
  await call(sa, 'DELETE', 'schools/' + A.schoolId);
  await call(sa, 'DELETE', 'schools/' + B.schoolId);
  console.log(fails === 0 ? '\nRÉSULTAT : TOUS LES TESTS SONT PASSÉS' : `\nRÉSULTAT : ${fails} TEST(S) EN ÉCHEC`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('Erreur :', e.message); process.exit(1); });
