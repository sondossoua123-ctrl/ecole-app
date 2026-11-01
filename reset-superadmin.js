// Réinitialise le mot de passe du super-administrateur avec les valeurs du fichier .env
// Utilisation :  node reset-superadmin.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

(async () => {
  if (!process.env.SUPERADMIN_PASSWORD || !process.env.SUPERADMIN_EMAIL) {
    console.error('SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD doivent exister dans .env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const hash = await bcrypt.hash(process.env.SUPERADMIN_PASSWORD, 10);
  const r = await mongoose.connection.db.collection('users').updateOne(
    { role: 'superadmin' },
    { $set: { password: hash, email: process.env.SUPERADMIN_EMAIL.toLowerCase().trim() } }
  );
  console.log(r.matchedCount, 'super-administrateur mis à jour');
  await mongoose.disconnect();
})().catch(e => { console.error('Erreur :', e.message); process.exit(1); });
