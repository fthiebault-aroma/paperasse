#!/usr/bin/env node

/**
 * Connecteur Dolibarr — écritures comptables
 *
 * Récupère les écritures du grand livre via l'API REST Dolibarr
 * et les transforme au format Paperasse (data/journal-entries.json).
 *
 * Variables d'environnement requises :
 *   DOLAPIKEY   — clé API Dolibarr (Accueil > Réglages > Sécurité > API)
 *   DOLIBARR_URL — URL de base, ex. https://dolibarr.example.com
 *
 * Usage :
 *   node integrations/dolibarr/fetch.js
 *   node integrations/dolibarr/fetch.js --start 2025-01-01 --end 2025-12-31
 *   node integrations/dolibarr/fetch.js --year 2025
 */

const fs   = require('fs');
const path = require('path');
const http = require('https');
const httpPlain = require('http');

const ROOT = path.join(__dirname, '..', '..');

// ─── Configuration ────────────────────────────────────────────────────────────

function loadConfig() {
  const companyPath = path.join(ROOT, 'company.json');
  if (!fs.existsSync(companyPath)) {
    console.error('Erreur : company.json introuvable. Copiez company.example.json et complétez-le.');
    process.exit(1);
  }
  const company = JSON.parse(fs.readFileSync(companyPath, 'utf8'));

  const apiKey = process.env.DOLAPIKEY;
  if (!apiKey) {
    console.error('Erreur : variable d\'environnement DOLAPIKEY manquante.');
    process.exit(1);
  }

  const rawUrl = process.env.DOLIBARR_URL || (company.dolibarr && company.dolibarr.url);
  if (!rawUrl) {
    console.error('Erreur : DOLIBARR_URL manquant (env ou company.json > dolibarr.url).');
    process.exit(1);
  }

  return { apiKey, baseUrl: rawUrl.replace(/\/$/, ''), company };
}

function parseDateArgs() {
  const args = process.argv.slice(2);
  let start = null;
  let end   = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) { start = args[++i]; }
    if (args[i] === '--end'   && args[i + 1]) { end   = args[++i]; }
    if (args[i] === '--year'  && args[i + 1]) {
      const y = parseInt(args[++i], 10);
      start = `${y}-01-01`;
      end   = `${y}-12-31`;
    }
  }
  return { start, end };
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function apiGet(baseUrl, apiKey, endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}/api/index.php${endpoint}`;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? http : httpPlain;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'DOLAPIKEY': apiKey,
        'Accept': 'application/json',
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} sur ${url}\n${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON invalide depuis ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Pagination ───────────────────────────────────────────────────────────────

async function fetchAllPages(baseUrl, apiKey, resource, params = {}) {
  const limit = 100;
  let page  = 0;
  const all = [];

  while (true) {
    const qs = new URLSearchParams({
      limit: String(limit),
      page: String(page),
      sortfield: 't.rowid',
      sortorder: 'ASC',
      ...params,
    }).toString();

    const items = await apiGet(baseUrl, apiKey, `/${resource}?${qs}`);

    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < limit) break;
    page++;

    await new Promise(r => setTimeout(r, 150)); // limite de débit douce
  }

  return all;
}

// ─── Transformation ───────────────────────────────────────────────────────────

/**
 * Dolibarr renvoie des lignes individuelles de grand livre.
 * On les regroupe par (code_journal + doc_ref + doc_date) pour
 * reconstituer les écritures multi-lignes au format Paperasse.
 */
function groupIntoEntries(lines) {
  const map = new Map();

  for (const line of lines) {
    const key = `${line.code_journal}||${line.doc_ref}||${line.doc_date}`;

    if (!map.has(key)) {
      map.set(key, {
        date:    line.doc_date ? line.doc_date.substring(0, 10) : '',
        journal: line.code_journal || '',
        ref:     line.doc_ref || '',
        label:   line.label_operation || line.label_compte || '',
        lines:   [],
      });
    }

    const entry = map.get(key);
    const debit  = parseFloat(line.debit)  || 0;
    const credit = parseFloat(line.credit) || 0;

    if (debit !== 0 || credit !== 0) {
      entry.lines.push({
        account: String(line.numero_compte || '').replace(/\s/g, ''),
        debit:   Math.round(debit  * 100) / 100,
        credit:  Math.round(credit * 100) / 100,
      });
    }
  }

  // Convertir en tableau et numéroter
  return Array.from(map.values())
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.ref.localeCompare(b.ref);
    })
    .map((entry, i) => ({ num: i + 1, ...entry }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { apiKey, baseUrl, company } = loadConfig();
  const { start, end } = parseDateArgs();

  // Période par défaut = exercice fiscal de company.json
  const dateStart = start || company.fiscal_year.start;
  const dateEnd   = end   || company.fiscal_year.end;

  console.log(`Dolibarr : ${baseUrl}`);
  console.log(`Période  : ${dateStart} → ${dateEnd}\n`);

  // Test de connexion
  try {
    await apiGet(baseUrl, apiKey, '/status');
    console.log('Connexion API Dolibarr : OK');
  } catch (e) {
    // /status n'existe pas sur toutes les versions — on continue quand même
    console.log('(endpoint /status non disponible — on continue)');
  }

  // Récupération des écritures du grand livre
  console.log('Récupération des écritures comptables...');

  const params = {
    date_start: dateStart,
    date_end:   dateEnd,
  };

  const rawLines = await fetchAllPages(baseUrl, apiKey, 'accountancy/bookkeeping', params);
  console.log(`  ${rawLines.length} lignes récupérées`);

  if (rawLines.length === 0) {
    console.warn('\nAucune écriture trouvée pour cette période.');
    console.warn('Vérifiez que la comptabilité est saisie dans Dolibarr (Comptabilité > Grand livre).');
    process.exit(0);
  }

  // Transformation au format Paperasse
  const entries = groupIntoEntries(rawLines);
  console.log(`  ${entries.length} écritures reconstituées`);

  // Vérification de l'équilibre (débit = crédit)
  let totalDebit  = 0;
  let totalCredit = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      totalDebit  += l.debit;
      totalCredit += l.credit;
    }
  }
  const ecart = Math.round((totalDebit - totalCredit) * 100) / 100;
  if (Math.abs(ecart) > 0.01) {
    console.warn(`\n⚠ Déséquilibre détecté : Débit ${totalDebit.toFixed(2)} ≠ Crédit ${totalCredit.toFixed(2)} (écart ${ecart.toFixed(2)} €)`);
    console.warn('  Vérifiez vos écritures dans Dolibarr avant de générer les états financiers.');
  } else {
    console.log(`  Équilibre OK (total débit = total crédit = ${totalDebit.toFixed(2)} €)`);
  }

  // Sauvegarde
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, 'journal-entries.json');
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));

  console.log(`\nFichier généré : data/journal-entries.json`);
  console.log('\nProchaine étape :');
  console.log('  node scripts/generate-statements.js');
  console.log('  → output/bilan.md');
  console.log('  → output/compte-de-resultat.md');
  console.log('  → output/balance.md');
}

main().catch(err => {
  console.error('\nErreur :', err.message);
  process.exit(1);
});
