// Migration : rattache toutes les données existantes à l'école n° 1.
// À lancer UNE SEULE FOIS :  node migrate.js
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  let school = await db.collection('schools').findOne({});
  if (!school) {
    const r = await db.collection('schools').insertOne({
      name: process.env.SCHOOL_NAME || 'École n°1', status: 'active', plan: 'basic', deleted: false, createdAt: new Date(), updatedAt: new Date()
    });
    school = { _id: r.insertedId };
    console.log('École n°1 créée.');
  } else console.log('École existante réutilisée :', school.name);

  for (const c of ['users', 'classes', 'subjects', 'students', 'grades', 'payments', 'homeworks', 'messages', 'audits']) {
    const filter = { schoolId: { $exists: false } };
    if (c === 'users') filter.role = { $ne: 'superadmin' };
    const r = await db.collection(c).updateMany(filter, { $set: { schoolId: school._id } });
    console.log(c.padEnd(10), ':', r.modifiedCount, 'document(s) rattaché(s)');
  }
  await mongoose.disconnect();
  console.log('Migration terminée.');
})().catch(e => { console.error('Erreur :', e.message); process.exit(1); });
