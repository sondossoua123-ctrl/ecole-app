require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const SECRET = process.env.JWT_SECRET || 'change-me';
const { Schema } = mongoose;
const oid = n => ({ type: Schema.Types.ObjectId, ref: n });
const SCHOOL_ROLES = ['admin', 'teacher', 'parent', 'student', 'accountant'];
const ROLES = [...SCHOOL_ROLES, 'superadmin'];
const anneeCourante = () => { const d = new Date(), y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1; return y + '-' + (y + 1); };
// Toute donnée métier appartient à une école : schoolId obligatoire et indexé
const mk = (n, def, tenant = true) => mongoose.model(n, new Schema({
  ...def, ...(tenant ? { schoolId: { ...oid('School'), required: true, index: true } } : {}), deleted: { type: Boolean, default: false }
}, { timestamps: true }));

/* ---------- Modèles ---------- */
const School = mk('School', { name: { type: String, required: true }, status: { type: String, enum: ['trial', 'active', 'suspended'], default: 'trial' }, plan: { type: String, default: 'basic' }, subscriptionEnd: Date }, false);
// Le super-administrateur (propriétaire du SaaS) n'est rattaché à aucune école
const User = mk('User', { schoolId: { ...oid('School'), index: true }, name: { type: String, required: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true }, password: String, role: { type: String, enum: ROLES, required: true } }, false);
const Classe = mk('Classe', { niveau: { type: String, required: true }, section: String, capacite: { type: Number, default: 25 }, titulaire: oid('User'), annee_scolaire: { type: String, default: anneeCourante } });
const Subject = mk('Subject', { nom: { type: String, required: true }, coefficient: { type: Number, default: 1 }, niveau: String });
const Student = mk('Student', { nom: { type: String, required: true }, prenom: { type: String, required: true }, dateNaissance: Date, classe: oid('Classe'), parent: oid('User'), user: oid('User'), scolarite: { type: Number, default: 0 }, medical: String, annee_scolaire: { type: String, default: anneeCourante } });
const Grade = mk('Grade', { student: { ...oid('Student'), required: true }, subject: { ...oid('Subject'), required: true }, valeur: { type: Number, min: 0, max: 20, required: true }, type: { type: String, default: 'Contrôle continu' }, trimestre: { type: Number, default: 1 }, commentaire: String, annee_scolaire: { type: String, default: anneeCourante } });
const Payment = mk('Payment', { student: { ...oid('Student'), required: true }, montant: { type: Number, required: true, min: 0 }, mode: { type: String, enum: ['Espèces', 'Virement', 'Mobile money'], default: 'Espèces' }, motif: { type: String, default: 'Scolarité' }, date: { type: Date, default: Date.now }, annee_scolaire: { type: String, default: anneeCourante } });
const Homework = mk('Homework', { titre: { type: String, required: true }, description: String, subject: oid('Subject'), classe: { ...oid('Classe'), required: true }, dateRemise: Date, annee_scolaire: { type: String, default: anneeCourante } });
const Message = mongoose.model('Message', new Schema({ schoolId: { ...oid('School'), index: true }, from: oid('User'), to: oid('User'), objet: String, corps: String, type: { type: String, default: 'message' }, hiddenFor: [oid('User')] }, { timestamps: true }));
const Audit = mongoose.model('Audit', new Schema({ schoolId: { ...oid('School'), index: true }, user: oid('User'), action: String, entity: String, ref: String, avant: Object, apres: Object }, { timestamps: true }));

/* ---------- Outils ---------- */
// L'école vient TOUJOURS du jeton (session), jamais d'un paramètre envoyé par le navigateur.
const schoolCache = new Map();
async function schoolOk(id) {
  const c = schoolCache.get(String(id)); if (c && c.t > Date.now()) return c.ok;
  const s = await School.findOne({ _id: id, deleted: false }).lean();
  const ok = !!s && s.status !== 'suspended' && !(s.subscriptionEnd && new Date(s.subscriptionEnd) < new Date());
  schoolCache.set(String(id), { ok, t: Date.now() + 30000 }); return ok;
}
const auth = async (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée, reconnectez-vous' }); }
  if (req.user.role !== 'superadmin') {
    try { if (!req.user.schoolId || !(await schoolOk(req.user.schoolId))) return res.status(403).json({ error: 'École suspendue ou abonnement expiré' }); }
    catch { return res.status(500).json({ error: 'Erreur serveur' }); }
  }
  next();
};
const only = (...r) => (req, res, next) => r.includes(req.user.role) ? next() : res.status(403).json({ error: 'Accès refusé' });
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.code === 11000 ? 'Cet email existe déjà' : e.message }));
const clean = (b, isNew) => { const x = { ...b }; ['_id', '__v', 'createdAt', 'updatedAt', 'deleted', 'schoolId'].forEach(k => delete x[k]); for (const k in x) if (x[k] === '') { if (isNew) delete x[k]; else x[k] = null; } return x; };
const strip = o => { const { password, ...x } = o; return x; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (t, b) => `<!doctype html><meta charset="utf-8"><title>${esc(t)}</title><style>body{font-family:Arial,sans-serif;max-width:720px;margin:30px auto;padding:0 16px}table{width:100%;border-collapse:collapse;margin:14px 0}td,th{border:1px solid #999;padding:6px;text-align:left}@media print{button{display:none}}</style>${b}<p><button onclick="print()">Imprimer / Enregistrer en PDF</button></p>`;
const canSee = (u, s) => ['admin', 'teacher', 'accountant'].includes(u.role) || (u.role === 'parent' && String(s.parent) === u.id) || (u.role === 'student' && String(s.user) === u.id);
const myStudents = async u => u.role === 'parent' ? Student.find({ schoolId: u.schoolId, parent: u.id, deleted: false }) : u.role === 'student' ? Student.find({ schoolId: u.schoolId, user: u.id, deleted: false }) : null;
const logAudit = (u, d) => Audit.create({ schoolId: u.schoolId || undefined, user: u.id, ...d });
// Un identifiant envoyé dans un formulaire (classe, élève, parent…) doit appartenir à la MÊME école
async function validateRefs(c, b, u) {
  for (const [f, M] of Object.entries(c.refs || {})) {
    const v = b[f]; if (v == null || v === '') continue;
    if (!mongoose.isValidObjectId(v) || !(await M.exists({ _id: v, schoolId: u.schoolId, deleted: false }))) throw new Error('Référence invalide : ' + f);
  }
}

/* ---------- CRUD générique : le filtre école est appliqué en UN SEUL endroit ---------- */
function crud(name, Model, c) {
  const r = express.Router(), pop = c.populate || [], prep = c.prep || (async b => b);
  r.get('/', auth, only(...c.read), wrap(async (req, res) => {
    const base = { deleted: false, schoolId: req.user.schoolId };
    const q = c.scope ? await c.scope(req.user, base) : base;
    res.json(await Model.find(q).populate(pop).select(c.select || '').sort('-createdAt').lean());
  }));
  r.post('/', auth, only(...c.write), wrap(async (req, res) => {
    const b = clean(req.body, true); await validateRefs(c, b, req.user);
    const d = await Model.create({ ...(await prep(b, true, req.user)), schoolId: req.user.schoolId });
    await logAudit(req.user, { action: 'create', entity: name, ref: d.id, apres: strip(d.toObject()) });
    if (c.after) await c.after(d, req.user);
    res.json({ ok: true });
  }));
  r.put('/:id', auth, only(...c.write), wrap(async (req, res) => {
    const old = await Model.findOne({ _id: req.params.id, deleted: false, schoolId: req.user.schoolId }).lean();
    if (!old) return res.status(404).json({ error: 'Introuvable' });
    const b = clean(req.body, false); await validateRefs(c, b, req.user);
    const d = await Model.findOneAndUpdate({ _id: req.params.id, schoolId: req.user.schoolId }, await prep(b, false, req.user), { new: true, runValidators: true }).lean();
    await logAudit(req.user, { action: 'update', entity: name, ref: req.params.id, avant: strip(old), apres: strip(d) });
    res.json({ ok: true });
  }));
  r.delete('/:id', auth, only(...c.write), wrap(async (req, res) => {
    const old = await Model.findOne({ _id: req.params.id, deleted: false, schoolId: req.user.schoolId });
    if (!old) return res.status(404).json({ error: 'Introuvable' });
    const msg = c.canDelete && await c.canDelete(req.params.id, req.user);
    if (msg) return res.status(409).json({ error: msg });
    old.deleted = true; if (name === 'users') old.email = old.email + '#' + Date.now();
    await old.save();
    await logAudit(req.user, { action: 'delete', entity: name, ref: req.params.id });
    res.json({ ok: true });
  }));
  app.use('/api/' + name, r);
}

const scopeStudents = async (u, q) => { if (u.role === 'parent') q.parent = u.id; if (u.role === 'student') q.user = u.id; return q; };
const scopeByStudent = async (u, q) => { const s = await myStudents(u); if (s) q.student = { $in: s.map(x => x._id) }; return q; };
const scopeHomework = async (u, q) => { const s = await myStudents(u); if (s) q.classe = { $in: s.map(x => x.classe).filter(Boolean) }; return q; };
const U = { path: 'parent', select: 'name' };

crud('users', User, {
  read: ['admin'], write: ['admin'], select: '-password',
  prep: async (b, isNew) => {
    if (b.role !== undefined && !SCHOOL_ROLES.includes(b.role)) throw new Error('Rôle non autorisé');
    if (b.password) b.password = await bcrypt.hash(b.password, 10); else if (isNew) throw new Error('Mot de passe obligatoire'); else delete b.password;
    return b;
  },
  canDelete: async (id, u) => id === u.id ? 'Vous ne pouvez pas supprimer votre propre compte' : null
});
crud('classes', Classe, {
  read: ['admin', 'teacher'], write: ['admin'], populate: [{ path: 'titulaire', select: 'name' }], refs: { titulaire: User },
  canDelete: async (id, u) => await Student.exists({ schoolId: u.schoolId, classe: id, deleted: false }) ? 'Cette classe contient des élèves : réaffectez-les d’abord' : null
});
crud('subjects', Subject, {
  read: ['admin', 'teacher'], write: ['admin'],
  canDelete: async (id, u) => await Grade.exists({ schoolId: u.schoolId, subject: id, deleted: false }) ? 'Cette matière a des notes rattachées' : null
});
crud('students', Student, {
  read: ['admin', 'teacher', 'parent', 'student', 'accountant'], write: ['admin'], scope: scopeStudents,
  populate: ['classe', U, { path: 'user', select: 'name' }], refs: { classe: Classe, parent: User, user: User }
});
crud('grades', Grade, { read: ['admin', 'teacher', 'parent', 'student'], write: ['admin', 'teacher'], scope: scopeByStudent, populate: ['student', 'subject'], refs: { student: Student, subject: Subject } });
crud('payments', Payment, {
  read: ['admin', 'accountant', 'parent'], write: ['admin', 'accountant'], scope: scopeByStudent, populate: ['student'], refs: { student: Student },
  after: async (p, user) => { // notification automatique au parent (reçoit l'école explicitement)
    const s = await Student.findOne({ _id: p.student, schoolId: user.schoolId });
    let statut = 'non envoyé (pas de parent lié)';
    if (s && s.parent) {
      const paid = (await Payment.find({ schoolId: user.schoolId, student: s._id, deleted: false })).reduce((a, x) => a + x.montant, 0);
      await Message.create({ schoolId: user.schoolId, from: user.id, to: s.parent, type: 'paiement', objet: 'Paiement enregistré – ' + s.prenom + ' ' + s.nom,
        corps: `Montant payé : ${p.montant} DT\nDate : ${new Date(p.date).toLocaleDateString('fr-FR')}\nMode : ${p.mode}\nSolde restant : ${s.scolarite - paid} DT\nVotre reçu est disponible dans la rubrique « Paiements ».` });
      statut = 'envoyé';
    }
    await logAudit(user, { action: 'notification-paiement', entity: 'payments', ref: p.id, apres: { destinataire: s && s.parent, statut } });
  }
});
crud('homework', Homework, { read: ['admin', 'teacher', 'parent', 'student'], write: ['admin', 'teacher'], scope: scopeHomework, populate: ['classe', 'subject'], refs: { classe: Classe, subject: Subject } });

/* ---------- Connexion ---------- */
app.post('/api/login', wrap(async (req, res) => {
  const u = await User.findOne({ email: (req.body.email || '').toLowerCase().trim(), deleted: false });
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password))) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  let school = null;
  if (u.role !== 'superadmin') {
    if (!u.schoolId || !(await schoolOk(u.schoolId))) return res.status(403).json({ error: 'École suspendue ou abonnement expiré. Contactez le support.' });
    school = await School.findById(u.schoolId).lean();
  }
  res.json({ token: jwt.sign({ id: u.id, role: u.role, name: u.name, schoolId: u.schoolId ? String(u.schoolId) : null }, SECRET, { expiresIn: '8h' }), user: { id: u.id, name: u.name, role: u.role, school: school ? school.name : null } });
}));

/* ---------- Bulletin (moyennes pondérées par coefficients) ---------- */
app.get('/api/bulletin/:id', auth, only('admin', 'teacher', 'parent', 'student'), wrap(async (req, res) => {
  const sc = req.user.schoolId;
  const s = await Student.findOne({ _id: req.params.id, schoolId: sc, deleted: false }).populate('classe');
  if (!s) throw new Error('Élève introuvable');
  if (!canSee(req.user, s)) return res.status(403).send('Accès refusé');
  const t = Number(req.query.trimestre) || 0;
  const grades = await Grade.find({ schoolId: sc, student: s._id, deleted: false, ...(t ? { trimestre: t } : {}) }).populate('subject');
  const by = {};
  grades.forEach(g => { if (!g.subject) return; const k = g.subject.id; (by[k] = by[k] || { nom: g.subject.nom, coef: g.subject.coefficient, v: [] }).v.push(g.valeur); });
  let sum = 0, coefs = 0;
  const rows = Object.values(by).map(m => { const avg = m.v.reduce((a, x) => a + x, 0) / m.v.length; sum += avg * m.coef; coefs += m.coef; return `<tr><td>${esc(m.nom)}</td><td>${m.coef}</td><td>${avg.toFixed(2)}</td></tr>`; }).join('');
  res.send(page('Bulletin', `<h2>Bulletin – ${esc(s.prenom)} ${esc(s.nom)}</h2><p>Classe : ${esc(s.classe ? s.classe.niveau + ' ' + (s.classe.section || '') : '—')} | Année : ${esc(s.annee_scolaire)} | ${t ? 'Trimestre ' + t : 'Année complète'}</p><table><tr><th>Matière</th><th>Coef.</th><th>Moyenne /20</th></tr>${rows || '<tr><td colspan=3>Aucune note</td></tr>'}</table><h3>Moyenne générale : ${coefs ? (sum / coefs).toFixed(2) : '—'} / 20</h3>`));
}));

/* ---------- Reçu de paiement ---------- */
app.get('/api/payments/:id/receipt', auth, only('admin', 'accountant', 'parent'), wrap(async (req, res) => {
  const sc = req.user.schoolId;
  const p = await Payment.findOne({ _id: req.params.id, schoolId: sc, deleted: false }).populate('student');
  if (!p || !p.student) throw new Error('Paiement introuvable');
  if (!canSee(req.user, p.student)) return res.status(403).send('Accès refusé');
  const paid = (await Payment.find({ schoolId: sc, student: p.student._id, deleted: false })).reduce((a, x) => a + x.montant, 0);
  res.send(page('Reçu', `<h2>Reçu de paiement n° ${p.id.slice(-6).toUpperCase()}</h2><table><tr><th>Élève</th><td>${esc(p.student.prenom)} ${esc(p.student.nom)}</td></tr><tr><th>Montant</th><td>${p.montant} DT</td></tr><tr><th>Date</th><td>${new Date(p.date).toLocaleDateString('fr-FR')}</td></tr><tr><th>Mode</th><td>${esc(p.mode)}</td></tr><tr><th>Motif</th><td>${esc(p.motif)}</td></tr><tr><th>Solde restant</th><td>${p.student.scolarite - paid} DT</td></tr></table>`));
}));

/* ---------- Messagerie (messages envoyés = immuables) ---------- */
const ALLOWED = { admin: SCHOOL_ROLES, teacher: ['admin', 'parent'], parent: ['admin', 'teacher'], student: ['admin'], accountant: ['admin', 'parent'] };
app.get('/api/contacts', auth, only(...SCHOOL_ROLES), wrap(async (req, res) => res.json(await User.find({ schoolId: req.user.schoolId, role: { $in: ALLOWED[req.user.role] }, deleted: false, _id: { $ne: req.user.id } }).select('name role').sort('name'))));
app.get('/api/messages', auth, only(...SCHOOL_ROLES), wrap(async (req, res) => {
  const q = req.query.box === 'out' ? { from: req.user.id } : { to: req.user.id, hiddenFor: { $ne: req.user.id } };
  res.json(await Message.find({ ...q, schoolId: req.user.schoolId }).populate('from to', 'name role').sort('-createdAt').lean());
}));
app.post('/api/messages', auth, only(...SCHOOL_ROLES), wrap(async (req, res) => {
  const to = await User.findOne({ _id: req.body.to, schoolId: req.user.schoolId, deleted: false });
  if (!to || !ALLOWED[req.user.role].includes(to.role)) return res.status(403).json({ error: 'Destinataire non autorisé pour votre rôle' });
  if (!req.body.objet || !req.body.corps) throw new Error('Objet et message obligatoires');
  await Message.create({ schoolId: req.user.schoolId, from: req.user.id, to: to._id, objet: req.body.objet, corps: req.body.corps });
  res.json({ ok: true });
}));
app.put('/api/messages/:id/hide', auth, only(...SCHOOL_ROLES), wrap(async (req, res) => { await Message.updateOne({ _id: req.params.id, schoolId: req.user.schoolId, to: req.user.id }, { $addToSet: { hiddenFor: req.user.id } }); res.json({ ok: true }); }));
app.post('/api/announce', auth, only('admin'), wrap(async (req, res) => {
  if (!req.body.objet || !req.body.corps) throw new Error('Objet et texte obligatoires');
  const roles = (req.body.roles && req.body.roles.length ? req.body.roles : SCHOOL_ROLES).filter(r => SCHOOL_ROLES.includes(r));
  const us = await User.find({ schoolId: req.user.schoolId, role: { $in: roles }, deleted: false });
  await Message.insertMany(us.map(u => ({ schoolId: req.user.schoolId, from: req.user.id, to: u._id, type: 'annonce', objet: '📢 ' + req.body.objet, corps: req.body.corps })));
  res.json({ envoyes: us.length });
}));

/* ---------- Super-administrateur (propriétaire du SaaS) : gestion des écoles ---------- */
const sup = [auth, only('superadmin')];
app.get('/api/schools', ...sup, wrap(async (req, res) => {
  const ss = await School.find({ deleted: false }).sort('-createdAt').lean();
  res.json(await Promise.all(ss.map(async s => ({ ...s, users: await User.countDocuments({ schoolId: s._id, deleted: false }), students: await Student.countDocuments({ schoolId: s._id, deleted: false }) }))));
}));
app.post('/api/schools', ...sup, wrap(async (req, res) => {
  const b = req.body;
  if (!b.name || !b.adminName || !b.adminEmail || !b.adminPassword) throw new Error('Nom de l’école et compte du directeur obligatoires');
  const s = await School.create({ name: b.name, status: b.status || 'active', plan: b.plan || 'basic', subscriptionEnd: b.subscriptionEnd || undefined });
  try { await User.create({ schoolId: s._id, name: b.adminName, email: b.adminEmail, password: await bcrypt.hash(b.adminPassword, 10), role: 'admin' }); }
  catch (e) { await School.deleteOne({ _id: s._id }); throw e; }
  await logAudit(req.user, { action: 'school-create', entity: 'schools', ref: s.id });
  res.json({ ok: true, id: s.id });
}));
app.put('/api/schools/:id', ...sup, wrap(async (req, res) => {
  const b = req.body, upd = {};
  ['name', 'status', 'plan'].forEach(k => { if (b[k]) upd[k] = b[k]; });
  if ('subscriptionEnd' in b) upd.subscriptionEnd = b.subscriptionEnd || null;
  const s = await School.findOneAndUpdate({ _id: req.params.id, deleted: false }, upd, { new: true, runValidators: true });
  if (!s) return res.status(404).json({ error: 'École introuvable' });
  schoolCache.delete(req.params.id);
  await logAudit(req.user, { action: 'school-update', entity: 'schools', ref: s.id, apres: upd });
  res.json({ ok: true });
}));
app.put('/api/schools/:id/admin-password', ...sup, wrap(async (req, res) => {
  if (!req.body.password || req.body.password.length < 6) throw new Error('Mot de passe trop court (6 caractères minimum)');
  const u = await User.findOne({ schoolId: req.params.id, role: 'admin', deleted: false }).sort('createdAt');
  if (!u) return res.status(404).json({ error: 'Directeur introuvable' });
  u.password = await bcrypt.hash(req.body.password, 10); await u.save();
  res.json({ ok: true });
}));
app.delete('/api/schools/:id', ...sup, wrap(async (req, res) => {
  const s = await School.findOneAndUpdate({ _id: req.params.id, deleted: false }, { deleted: true });
  if (!s) return res.status(404).json({ error: 'École introuvable' });
  schoolCache.delete(req.params.id);
  await logAudit(req.user, { action: 'school-delete', entity: 'schools', ref: s.id });
  res.json({ ok: true });
}));

/* ---------- Changer son propre mot de passe (tous les rôles) ---------- */
app.put('/api/me/password', auth, wrap(async (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 6) throw new Error('Nouveau mot de passe trop court (6 caractères minimum)');
  const u = await User.findOne({ _id: req.user.id, deleted: false });
  if (!u || !(await bcrypt.compare(current || '', u.password))) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  u.password = await bcrypt.hash(password, 10); await u.save();
  await logAudit(req.user, { action: 'password-change', entity: 'users', ref: u.id });
  res.json({ ok: true });
}));

/* ---------- Démarrage ---------- */
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  if (!(await User.exists({ role: 'superadmin', deleted: false }))) {
    const email = process.env.SUPERADMIN_EMAIL || 'superadmin@saas.tn', pw = process.env.SUPERADMIN_PASSWORD || 'Super1234';
    await User.create({ name: 'Super administrateur', email, password: await bcrypt.hash(pw, 10), role: 'superadmin' });
    console.log('Compte super-administrateur créé :', email);
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Application sur http://localhost:' + port));
}).catch(e => { console.error('Erreur MongoDB :', e.message); process.exit(1); });
