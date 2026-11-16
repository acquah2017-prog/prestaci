const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.join(__dirname, 'prestaci_marketplace.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erreur de connexion à la base de données SQLite:', err.message);
  } else {
    console.log('Connecté à la base de données SQLite avec succès.');
  }
});

// Création de la table et insertion de l'administrateur personnalisé
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'pending'
  )`, () => {
    db.run(`INSERT OR IGNORE INTO users (phone, password, role, status) VALUES ('0768356435', 'Cancer1993.', 'admin', 'approved')`);
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serveur PrestaCI démarré sur le port ${PORT}`);
});
