const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'prestaci_national_secret_key';

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const db = new DatabaseSync('./prestaci_marketplace.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT NOT NULL,
        telephone TEXT UNIQUE NOT NULL,
        mot_de_passe TEXT NOT NULL,
        role TEXT CHECK(role IN ('client', 'prestataire', 'admin')) NOT NULL,
        ville TEXT DEFAULT 'Abidjan',
        quartier TEXT,
        date_creation DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prestataires_profils (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        metier TEXT NOT NULL,
        description TEXT,
        statut_validation TEXT DEFAULT 'en_attente',
        solde_credits INTEGER DEFAULT 3,
        abonnement_actif INTEGER DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS demandes_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        metier_recherche TEXT NOT NULL,
        ville TEXT DEFAULT 'Abidjan',
        quartier TEXT,
        description_besoin TEXT NOT NULL,
        budget_estime TEXT,
        statut TEXT DEFAULT 'ouvert',
        date_demande DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(client_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT CHECK(type IN ('achat_credits', 'abonnement', 'commission')) NOT NULL,
        montant_fcfa INTEGER NOT NULL,
        operateur TEXT NOT NULL,
        reference_paiement TEXT,
        statut TEXT DEFAULT 'valide',
        date_transaction DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
`);

// Inscription
app.post('/api/register', async (req, res) => {
    try {
        const { nom, telephone, mot_de_passe, role, ville, quartier, metier, description } = req.body;
        if (!nom || !telephone || !mot_de_passe || !role) return res.status(400).json({ erreur: 'Champs obligatoires manquants.' });
        const hashedPassword = await bcrypt.hash(mot_de_passe, 8);
        const result = db.prepare(`INSERT INTO users (nom, telephone, mot_de_passe, role, ville, quartier) VALUES (?, ?, ?, ?, ?, ?)`).run(nom, telephone, hashedPassword, role, ville || 'Abidjan', quartier || 'Centre');
        const userId = result.lastInsertRowid;
        if (role === 'prestataire') {
            if (!metier) return res.status(400).json({ erreur: 'Métier requis pour un prestataire.' });
            db.prepare(`INSERT INTO prestataires_profils (user_id, metier, description, solde_credits) VALUES (?, ?, ?, 3)`).run(userId, metier, description || '');
        }
        res.status(201).json({ message: 'Inscription réussie sur PrestaCI', userId });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur inscription (Numéro déjà utilisé ?)', details: err.message });
    }
});

// Connexion
app.post('/api/login', async (req, res) => {
    try {
        const { telephone, mot_de_passe } = req.body;
        const user = db.prepare(`SELECT * FROM users WHERE telephone = ?`).get(telephone);
        if (!user || !(await bcrypt.compare(mot_de_passe, user.mot_de_passe))) return res.status(401).json({ erreur: 'Identifiants incorrects.' });
        const token = jwt.sign({ id: user.id, role: user.role }, SECRET_KEY, { expiresIn: '7d' });
        res.json({ message: 'Connexion réussie', token, role: user.role, nom: user.nom, userId: user.id });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur connexion', details: err.message });
    }
});

// Lister prestataires
app.get('/api/prestataires', (req, res) => {
    const stmt = db.prepare(`
        SELECT u.id as user_id, u.nom, u.telephone, u.ville, u.quartier, p.metier, p.description, p.statut_validation, p.abonnement_actif, p.solde_credits 
        FROM users u 
        JOIN prestataires_profils p ON u.id = p.user_id 
        WHERE u.role = 'prestataire'
    `);
    res.json(stmt.all());
});

// Poster une demande
app.post('/api/demandes', (req, res) => {
    try {
        const { client_id, metier_recherche, ville, quartier, description_besoin, budget_estime } = req.body;
        if (!client_id || !metier_recherche || !description_besoin) return res.status(400).json({ erreur: 'Informations incomplètes.' });
        const result = db.prepare(`INSERT INTO demandes_services (client_id, metier_recherche, ville, quartier, description_besoin, budget_estime) VALUES (?, ?, ?, ?, ?, ?)`).run(client_id, metier_recherche, ville || 'Abidjan', quartier || 'Centre', description_besoin, budget_estime || 'Libre');
        res.status(201).json({ message: 'Demande publiée', demandeId: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur publication', details: err.message });
    }
});

// Lister demandes
app.get('/api/demandes', (req, res) => {
    const stmt = db.prepare(`
        SELECT d.*, u.nom as client_nom, u.ville as client_ville 
        FROM demandes_services d 
        JOIN users u ON d.client_id = u.id 
        WHERE d.statut = 'ouvert' 
        ORDER BY d.date_demande DESC
    `);
    res.json(stmt.all());
});

// Débloquer contact
app.post('/api/demandes/:id/debloquer', (req, res) => {
    try {
        const demandeId = req.params.id;
        const { prestataire_id } = req.body;
        const pro = db.prepare(`SELECT * FROM prestataires_profils WHERE user_id = ?`).get(prestataire_id);
        if (!pro) return res.status(404).json({ erreur: 'Prestataire introuvable.' });

        if (pro.statut_validation !== 'valide') {
            return res.status(403).json({ erreur: 'Votre compte prestataire est en attente de validation par l\'administrateur.' });
        }

        if (pro.abonnement_actif === 0 && pro.solde_credits <= 0) {
            return res.status(403).json({ erreur: 'Solde épuisé ! Veuillez souscrire à un abonnement ou recharger votre compte.' });
        }

        if (pro.abonnement_actif === 0) {
            db.prepare(`UPDATE prestataires_profils SET solde_credits = solde_credits - 1 WHERE user_id = ?`).run(prestataire_id);
        }

        const demandeInfo = db.prepare(`SELECT d.*, u.nom as client_nom, u.telephone as client_telephone FROM demandes_services d JOIN users u ON d.client_id = u.id WHERE d.id = ?`).get(demandeId);
        if (!demandeInfo) return res.status(404).json({ erreur: 'Demande introuvable.' });

        res.json({
            message: 'Contact débloqué avec succès !',
            client: { nom: demandeInfo.client_nom, telephone: demandeInfo.client_telephone, ville: demandeInfo.ville, quartier: demandeInfo.quartier, besoin: demandeInfo.description_besoin }
        });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur déblocage', details: err.message });
    }
});

// Passerelle de Paiement Automatisée (Webhook Simulator)
app.post('/api/transactions', (req, res) => {
    try {
        const { user_id, type, montant_fcfa, operateur } = req.body;
        const refTransaction = 'CI-PAY-' + Math.floor(100000 + Math.random() * 900000);

        db.prepare(`INSERT INTO transactions (user_id, type, montant_fcfa, operateur, reference_paiement) VALUES (?, ?, ?, ?, ?)`).run(user_id, type, montant_fcfa, operateur, refTransaction);
        
        if (type === 'achat_credits') {
            db.prepare(`UPDATE prestataires_profils SET solde_credits = solde_credits + 5 WHERE user_id = ?`).run(user_id);
        } else if (type === 'abonnement') {
            db.prepare(`UPDATE prestataires_profils SET abonnement_actif = 1 WHERE user_id = ?`).run(user_id);
        }

        res.status(201).json({ message: 'Paiement automatisé validé avec succès par l\'opérateur !', reference: refTransaction });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur passerelle de paiement', details: err.message });
    }
});

// Admin : Valider un prestataire
app.patch('/api/admin/prestataires/:id/valider', (req, res) => {
    try {
        const prestataireId = req.params.id;
        db.prepare(`UPDATE prestataires_profils SET statut_validation = 'valide' WHERE user_id = ?`).run(prestataireId);
        res.json({ message: 'Prestataire validé avec succès !' });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur validation', details: err.message });
    }
});

// Admin : Supprimer un utilisateur (Client ou Prestataire inactif)
app.delete('/api/admin/users/:id', (req, res) => {
    try {
        const userId = req.params.id;
        db.prepare(`DELETE FROM prestataires_profils WHERE user_id = ?`).run(userId);
        db.prepare(`DELETE FROM demandes_services WHERE client_id = ?`).run(userId);
        db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
        res.json({ message: 'Utilisateur supprimé avec succès du système.' });
    } catch (err) {
        res.status(500).json({ erreur: 'Erreur lors de la suppression', details: err.message });
    }
});

// Admin Stats & Données complètes
app.get('/api/admin/data', (req, res) => {
    const totalRevenus = db.prepare(`SELECT SUM(montant_fcfa) as total FROM transactions WHERE statut = 'valide'`).get().total || 0;
    const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users`).get().count;
    const totalDemandes = db.prepare(`SELECT COUNT(*) as count FROM demandes_services`).get().count;
    const prestataires = db.prepare(`
        SELECT u.id as user_id, u.nom, u.telephone, u.ville, p.metier, p.statut_validation, p.solde_credits, p.abonnement_actif 
        FROM users u JOIN prestataires_profils p ON u.id = p.user_id WHERE u.role = 'prestataire'
    `).all();
    const transactions = db.prepare(`SELECT t.*, u.nom FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.date_transaction DESC`).all();

    res.json({
        chiffre_affaires_fcfa: totalRevenus,
        utilisateurs: totalUsers,
        demandes: totalDemandes,
        prestataires: prestataires,
        transactions: transactions
    });
});

app.listen(PORT, () => {
    console.log(`Serveur PrestaCI opérationnel sur le port ${PORT}`);
});
