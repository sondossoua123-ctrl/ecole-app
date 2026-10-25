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
const ROLES = ['admin', 'teacher', 'parent', 'student', 'accountant'];
const anneeCourante = () => { const d = new Date(), y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1; return y + '-' + (y + 1); };
const mk = (n, def) => mongoose.model(n, new Schema({ ...def, deleted: { type: Boolean, default: false } }, { timestamps: true }));

/* ---------- Modèles ---------- */
const User = mk('User', { name: { type: String, required: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true }, password: String, role: { type: String, enum: ROLES, required: true } });
const Classe = mk('Classe', { niveau: { type: String, required: true }, section: String, capacite: { type: Number, default: 25 }, titulaire: oid('User'), annee_scolaire: { type: String, default: anneeCourante } });
const Subject = mk('Subject', { nom: { type: String, required: true }, coefficient: { type: Number, default: 1 }, niveau: String });
const Student = mk('Student', { nom: { type: String, required: true }, prenom: { type: String, required: true }, dateNaissance: Date, classe: oid('Classe'), parent: oid('User'), user: oid('User'), scolarite: { type: Number, default: 0 }, medical: String, annee_scolaire: { type: String, default: anneeCourante } });
const Grade = mk('Grade', { student: { ...oid('Student'), required: true }, subject: { ...oid('Subject'), required: true }, valeur: { type: Number, min: 0, max: 20, required: true }, type: { type: String, default: 'Contrôle continu' }, trimestre: { type: Number, default: 1 }, commentaire: String, annee_scolaire: { type: String, default: anneeCourante } });
const Payment = mk('Payment', { student: { ...oid('Student'), required: true }, montant: { type: Number, required: true, min: 0 }, mode: { type: String, enum: ['Espèces', 'Virement', 'Mobile money'], default: 'Espèces' }, motif: { type: String, default: 'Scolarité' }, date: { type: Date, default: Date.now }, annee_scolaire: { type: String, default: anneeCourante } });
const Homework = mk('Homework', { titre: { type: String, required: true }, description: String, subject: oid('Subject'), classe: { ...oid('Classe'), required: true }, dateRemise: Date, annee_scolaire: { type: String, default: anneeCourante } });
const Message = mongoose.model('Message', new Schema({ from: oid('User'), to: oid('User'), objet: String, corps: String, type: { type: String, default: 'message' }, hiddenFor: [oid('User')] }, { timestamps: true }));
const Audit = mongoose.model('Audit', new Schema({ user: oid('User'), action: String, entity: String, ref: String, avant: Object, apres: Object }, { timestamps: true }));

/* ---------- Outils ---------- */
const auth = (req, res, next) => { try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); } catch { res.status(401).json({ error: 'Session expirée, reconnectez-vous' }); } };
const only = (...r) => (req, res, next) => r.includes(req.user.role) ? next() : res.status(403).json({ error: 'Accès refusé' });
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.code === 11000 ? 'Cet email existe déjà' : e.message }));
const clean = (b, isNew) => { const x = { ...b }; ['_id', '__v', 'createdAt', 'updatedAt', 'deleted'].forEach(k => delete x[k]); for (const k in x) if (x[k] === '') { if (isNew) delete x[k]; else x[k] = null; } return x; };
const strip = o => { const { password, ...x } = o; return x; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (t, b) => `<!doctype html><meta charset="utf-8"><title>${esc(t)}</title><style>body{font-family:Arial,sans-serif;max-width:720px;margin:30px auto;padding:0 16px}table{width:100%;border-collapse:collapse;margin:14px 0}td,th{border:1px solid #999;padding:6px;text-align:left}@media print{button{display:none}}</style>${b}<p><button onclick="print()">Imprimer / Enregistrer en PDF</button></p>`;
const canSee = (u, s) => ['admin', 'teacher', 'accountant'].includes(u.role) || (u.role === 'parent' && String(s.parent) === u.id) || (u.role === 'student' && String(s.user) === u.id);
const myStudents = async u => u.role === 'parent' ? Student.find({ parent: u.id, deleted: false }) : u.role === 'student' ? Student.find({ user: u.id, deleted: false }) : null;

/* ---------- CRUD générique (ajout, modification, suppression logique, journal) ---------- */
function crud(name, Model, c) {
  const r = express.Router(), pop = c.populate || [], prep = c.prep || (async b => b);
  r.get('/', auth, only(...c.read), wrap(async (req, res) => {
    const q = c.scope ? await c.scope(req.user, { deleted: false }) : { deleted: false };
    res.json(await Model.find(q).populate(pop).select(c.select || '').sort('-createdAt').lean());
  }));
  r.post('/', auth, only(...c.write), wrap(async (req, res) => {
    const d = await Model.create(await prep(clean(req.body, true), true));
    await Audit.create({ user: req.user.id, action: 'create', entity: name, ref: d.id, apres: strip(d.toObject()) });
    if (c.after) await c.after(d, req.user);
    res.json({ ok: true });
  }));
  r.put('/:id', auth, only(...c.write), wrap(async (req, res) => {
    const old = await Model.findOne({ _id: req.params.id, deleted: false }).lean();
    if (!old) return res.status(404).json({ error: 'Introuvable' });
    const d = await Model.findByIdAndUpdate(req.params.id, await prep(clean(req.body, false), false), { new: true, runValidators: true }).lean();
    await Audit.create({ user: req.user.id, action: 'update', entity: name, ref: req.params.id, avant: strip(old), apres: strip(d) });
    res.json({ ok: true });
  }));
  r.delete('/:id', auth, only(...c.write), wrap(async (req, res) => {
    const msg = c.canDelete && await c.canDelete(req.params.id, req.user);
    if (msg) return res.status(409).json({ error: msg });
    const old = await Model.findOne({ _id: req.params.id, deleted: false });
    if (!old) return res.status(404).json({ error: 'Introuvable' });
    old.deleted = true; if (name === 'users') old.email = old.email + '#' + Date.now();
    await old.save();
    await Audit.create({ user: req.user.id, action: 'delete', entity: name, ref: req.params.id });
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
  prep: async (b, isNew) => { if (b.password) b.password = await bcrypt.hash(b.password, 10); else if (isNew) throw new Error('Mot de passe obligatoire'); else delete b.password; return b; },
  canDelete: async (id, u) => id === u.id ? 'Vous ne pouvez pas supprimer votre propre compte' : null
});
crud('classes', Classe, {
  read: ['admin', 'teacher'], write: ['admin'], populate: [{ path: 'titulaire', select: 'name' }],
  canDelete: async id => await Student.exists({ classe: id, deleted: false }) ? 'Cette classe contient des élèves : réaffectez-les d’abord' : null
});
crud('subjects', Subject, {
  read: ['admin', 'teacher'], write: ['admin'],
  canDelete: async id => await Grade.exists({ subject: id, deleted: false }) ? 'Cette matière a des notes rattachées' : null
});
crud('students', Student, {
  read: ['admin', 'teacher', 'parent', 'student', 'accountant'], write: ['admin'], scope: scopeStudents,
  populate: ['classe', U, { path: 'user', select: 'name' }]
});
crud('grades', Grade, { read: ['admin', 'teacher', 'parent', 'student'], write: ['admin', 'teacher'], scope: scopeByStudent, populate: ['student', 'subject'] });
crud('payments', Payment, {
  read: ['admin', 'accountant', 'parent'], write: ['admin', 'accountant'], scope: scopeByStudent, populate: ['student'],
  after: async (p, user) => { // notification automatique au parent après paiement
    const s = await Student.findById(p.student);
    let statut = 'non envoyé (pas de parent lié)';
    if (s && s.parent) {
      const paid = (await Payment.find({ student: s._id, deleted: false })).reduce((a, x) => a + x.montant, 0);
      await Message.create({ from: user.id, to: s.parent, type: 'paiement', objet: 'Paiement enregistré – ' + s.prenom + ' ' + s.nom,
        corps: `Montant payé : ${p.montant} DT\nDate : ${new Date(p.date).toLocaleDateString('fr-FR')}\nMode : ${p.mode}\nSolde restant : ${s.scolarite - paid} DT\nVotre reçu est disponible dans la rubrique « Paiements ».` });
      statut = 'envoyé';
    }
    await Audit.create({ user: user.id, action: 'notification-paiement', entity: 'payments', ref: p.id, apres: { destinataire: s && s.parent, statut } });
  }
});
crud('homework', Homework, { read: ['admin', 'teacher', 'parent', 'student'], write: ['admin', 'teacher'], scope: scopeHomework, populate: ['classe', 'subject'] });

/* ---------- Connexion ---------- */
app.post('/api/login', wrap(async (req, res) => {
  const u = await User.findOne({ email: (req.body.email || '').toLowerCase().trim(), deleted: false });
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password))) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '8h' }), user: { id: u.id, name: u.name, role: u.role } });
}));

/* ---------- Bulletin (moyennes pondérées par coefficients) ---------- */
app.get('/api/bulletin/:id', auth, only('admin', 'teacher', 'parent', 'student'), wrap(async (req, res) => {
  const s = await Student.findOne({ _id: req.params.id, deleted: false }).populate('classe');
  if (!s) throw new Error('Élève introuvable');
  if (!canSee(req.user, s)) return res.status(403).send('Accès refusé');
  const t = Number(req.query.trimestre) || 0;
  const grades = await Grade.find({ student: s._id, deleted: false, ...(t ? { trimestre: t } : {}) }).populate('subject');
  const by = {};
  grades.forEach(g => { if (!g.subject) return; const k = g.subject.id; (by[k] = by[k] || { nom: g.subject.nom, coef: g.subject.coefficient, v: [] }).v.push(g.valeur); });
  let sum = 0, coefs = 0;
  const rows = Object.values(by).map(m => { const avg = m.v.reduce((a, x) => a + x, 0) / m.v.length; sum += avg * m.coef; coefs += m.coef; return `<tr><td>${esc(m.nom)}</td><td>${m.coef}</td><td>${avg.toFixed(2)}</td></tr>`; }).join('');
  res.send(page('Bulletin', `<h2>Bulletin – ${esc(s.prenom)} ${esc(s.nom)}</h2><p>Classe : ${esc(s.classe ? s.classe.niveau + ' ' + (s.classe.section || '') : '—')} | Année : ${esc(s.annee_scolaire)} | ${t ? 'Trimestre ' + t : 'Année complète'}</p><table><tr><th>Matière</th><th>Coef.</th><th>Moyenne /20</th></tr>${rows || '<tr><td colspan=3>Aucune note</td></tr>'}</table><h3>Moyenne générale : ${coefs ? (sum / coefs).toFixed(2) : '—'} / 20</h3>`));
}));

/* ---------- Reçu de paiement ---------- */
app.get('/api/payments/:id/receipt', auth, only('admin', 'accountant', 'parent'), wrap(async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, deleted: false }).populate('student');
  if (!p || !p.student) throw new Error('Paiement introuvable');
  if (!canSee(req.user, p.student)) return res.status(403).send('Accès refusé');
  const paid = (await Payment.find({ student: p.student._id, deleted: false })).reduce((a, x) => a + x.montant, 0);
  res.send(page('Reçu', `<h2>Reçu de paiement n° ${p.id.slice(-6).toUpperCase()}</h2><table><tr><th>Élève</th><td>${esc(p.student.prenom)} ${esc(p.student.nom)}</td></tr><tr><th>Montant</th><td>${p.montant} DT</td></tr><tr><th>Date</th><td>${new Date(p.date).toLocaleDateString('fr-FR')}</td></tr><tr><th>Mode</th><td>${esc(p.mode)}</td></tr><tr><th>Motif</th><td>${esc(p.motif)}</td></tr><tr><th>Solde restant</th><td>${p.student.scolarite - paid} DT</td></tr></table>`));
}));

/* ---------- Messagerie (messages envoyés = immuables) ---------- */
const ALLOWED = { admin: ROLES, teacher: ['admin', 'parent'], parent: ['admin', 'teacher'], student: ['admin'], accountant: ['admin', 'parent'] };
app.get('/api/contacts', auth, wrap(async (req, res) => res.json(await User.find({ role: { $in: ALLOWED[req.user.role] }, deleted: false, _id: { $ne: req.user.id } }).select('name role').sort('name'))));
app.get('/api/messages', auth, wrap(async (req, res) => {
  const q = req.query.box === 'out' ? { from: req.user.id } : { to: req.user.id, hiddenFor: { $ne: req.user.id } };
  res.json(await Message.find(q).populate('from to', 'name role').sort('-createdAt').lean());
}));
app.post('/api/messages', auth, wrap(async (req, res) => {
  const to = await User.findOne({ _id: req.body.to, deleted: false });
  if (!to || !ALLOWED[req.user.role].includes(to.role)) return res.status(403).json({ error: 'Destinataire non autorisé pour votre rôle' });
  if (!req.body.objet || !req.body.corps) throw new Error('Objet et message obligatoires');
  await Message.create({ from: req.user.id, to: to._id, objet: req.body.objet, corps: req.body.corps });
  res.json({ ok: true });
}));
app.put('/api/messages/:id/hide', auth, wrap(async (req, res) => { await Message.updateOne({ _id: req.params.id, to: req.user.id }, { $addToSet: { hiddenFor: req.user.id } }); res.json({ ok: true }); }));
app.post('/api/announce', auth, only('admin'), wrap(async (req, res) => {
  if (!req.body.objet || !req.body.corps) throw new Error('Objet et texte obligatoires');
  const roles = req.body.roles && req.body.roles.length ? req.body.roles : ROLES;
  const us = await User.find({ role: { $in: roles }, deleted: false });
  await Message.insertMany(us.map(u => ({ from: req.user.id, to: u._id, type: 'annonce', objet: '📢 ' + req.body.objet, corps: req.body.corps })));
  res.json({ envoyes: us.length });
}));

/* ---------- Démarrage ---------- */
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  if (!(await User.exists({ role: 'admin', deleted: false }))) {
    const email = process.env.ADMIN_EMAIL || 'admin@ecole.tn', pw = process.env.ADMIN_PASSWORD || 'Admin1234';
    await User.create({ name: 'Administrateur', email, password: await bcrypt.hash(pw, 10), role: 'admin' });
    console.log('Compte admin créé :', email);
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Application sur http://localhost:' + port));
}).catch(e => { console.error('Erreur MongoDB :', e.message); process.exit(1); });
