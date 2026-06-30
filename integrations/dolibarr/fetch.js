#!/usr/bin/env node

/**
 * Connecteur Dolibarr — écritures comptables (grand livre)
 *
 * Deux modes :
 *   --api  Utilise l'API REST Dolibarr (nécessite le module API accountancy activé)
 *   --db   Lit directement la base MySQL de Dolibarr (mode par défaut si l'API échoue)
 *
 * Variables d'environnement :
 *   Mode API  : DOLAPIKEY, DOLIBARR_URL
 *   Mode DB   : DOLIBARR_DB_HOST (défaut: localhost), DOLIBARR_DB_PORT (défaut: 3306),
 *               DOLIBARR_DB_USER, DOLIBARR_DB_PASS, DOLIBARR_DB_NAME (défaut: dolibarr)
 *
 * Usage :
 *   node integrations/dolibarr/fetch.js
 *   node integrations/dolibarr/fetch.js --year 2025
 *   node integrations/dolibarr/fetch.js --start 2023-01-01 --end 2024-12-31
 *   node integrations/dolibarr/fetch.js --db --start 2023-01-01 --end 2024-12-31
 */

const fs   = require('fs');
const path = require('path');
const http = require('https');
const httpPlain = require('http');

const ROOT = path.join(__dirname, '..', '..');

// ─── Arguments CLI ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let start   = null;
  let end     = null;
  let forceDb  = false;
  let forceApi = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) start = args[++i];
    if (args[i] === '--end'   && args[i + 1]) end   = args[++i];
    if (args[i] === '--year'  && args[i + 1]) {
      const y = parseInt(args[++i], 10);
      start = `${y}-01-01`;
      end   = `${y}-12-31`;
    }
    if (args[i] === '--db')  forceDb  = true;
    if (args[i] === '--api') forceApi = true;
  }
  return { start, end, forceDb, forceApi };
}

// ─── Configuration ────────────────────────────────────────────────────────────

function loadCompany() {
  const p = path.join(ROOT, 'company.json');
  if (!fs.existsSync(p)) {
    console.error('Erreur : company.json introuvable. Copiez company.example.json et complétez-le.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function dbConfig() {
  const company = loadCompany();
  const db = (company.dolibarr && company.dolibarr.db) || {};
  return {
    host:     process.env.DOLIBARR_DB_HOST || db.host || 'localhost',
    port:     parseInt(process.env.DOLIBARR_DB_PORT || db.port || '3306', 10),
    user:     process.env.DOLIBARR_DB_USER || db.user,
    password: process.env.DOLIBARR_DB_PASS || db.password || '',
    database: process.env.DOLIBARR_DB_NAME || db.name || 'dolibarr',
  };
}

function apiConfig() {
  const company = loadCompany();
  const apiKey  = process.env.DOLAPIKEY;
  const rawUrl  = process.env.DOLIBARR_URL || (company.dolibarr && company.dolibarr.url);
  return { apiKey, baseUrl: rawUrl ? rawUrl.replace(/\/$/, '') : null };
}

// ─── Transformation commune ───────────────────────────────────────────────────

/**
 * Regroupe les lignes individuelles du grand livre en écritures multi-lignes
 * au format Paperasse journal-entries.json.
 */
function groupIntoEntries(lines) {
  const map = new Map();

  for (const line of lines) {
    const key = `${line.code_journal}||${line.doc_ref}||${line.doc_date}`;

    if (!map.has(key)) {
      map.set(key, {
        date:    line.doc_date ? String(line.doc_date).substring(0, 10) : '',
        journal: line.code_journal || '',
        ref:     line.doc_ref     || '',
        label:   line.label_operation || line.label_compte || '',
        lines:   [],
      });
    }

    const entry  = map.get(key);
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

  return Array.from(map.values())
    .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : a.ref.localeCompare(b.ref))
    .map((entry, i) => ({ num: i + 1, ...entry }));
}

function printSummary(entries) {
  let totalDebit = 0, totalCredit = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      totalDebit  += l.debit;
      totalCredit += l.credit;
    }
  }
  const ecart = Math.round((totalDebit - totalCredit) * 100) / 100;

  console.log(`  ${entries.length} écritures reconstituées`);
  if (Math.abs(ecart) > 0.01) {
    console.warn(`\n⚠ Déséquilibre : Débit ${totalDebit.toFixed(2)} ≠ Crédit ${totalCredit.toFixed(2)} (écart ${ecart.toFixed(2)} €)`);
    console.warn('  Vérifiez vos écritures dans Dolibarr avant de générer les états.');
  } else {
    console.log(`  Équilibre OK — total débit = crédit = ${totalDebit.toFixed(2)} €`);
  }
}

// ─── Mode DB (MySQL) ──────────────────────────────────────────────────────────

async function fetchViaDB(dateStart, dateEnd) {
  let mysql2;
  try {
    mysql2 = require('mysql2/promise');
  } catch {
    console.error('Erreur : le package mysql2 n\'est pas installé.');
    console.error('Lancez : npm install mysql2');
    process.exit(1);
  }

  const cfg = dbConfig();
  if (!cfg.user) {
    console.error('Erreur : DOLIBARR_DB_USER manquant (env ou company.json > dolibarr.db.user).');
    process.exit(1);
  }

  console.log(`Mode : MySQL direct (${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database})`);
  console.log(`Période : ${dateStart} → ${dateEnd}\n`);

  const conn = await mysql2.createConnection(cfg);

  try {
    const [rows] = await conn.execute(
      `SELECT
         doc_date, doc_ref, code_journal, journal_label,
         label_operation, label_compte, numero_compte,
         debit, credit
       FROM llx_accounting_bookkeeping
       WHERE doc_date BETWEEN ? AND ?
       ORDER BY doc_date ASC, piece_num ASC, rowid ASC`,
      [dateStart, dateEnd]
    );

    console.log(`  ${rows.length} lignes récupérées`);
    return rows;
  } finally {
    await conn.end();
  }
}

// ─── Mode API REST ────────────────────────────────────────────────────────────

function apiGet(baseUrl, apiKey, endpoint) {
  return new Promise((resolve, reject) => {
    const url    = `${baseUrl}/api/index.php${endpoint}`;
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? http : httpPlain;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'DOLAPIKEY': apiKey, 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 501) {
          reject(new Error('API_NOT_AVAILABLE'));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} — ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON invalide: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAllPages(baseUrl, apiKey, resource, params = {}) {
  const limit = 100;
  let page = 0;
  const all = [];

  while (true) {
    const qs = new URLSearchParams({ limit: String(limit), page: String(page),
      sortfield: 't.rowid', sortorder: 'ASC', ...params }).toString();
    const items = await apiGet(baseUrl, apiKey, `/${resource}?${qs}`);
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    if (items.length < limit) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
  }
  return all;
}

async function fetchViaAPI(dateStart, dateEnd) {
  const { apiKey, baseUrl } = apiConfig();
  if (!apiKey || !baseUrl) {
    throw new Error('DOLAPIKEY ou DOLIBARR_URL manquant pour le mode API.');
  }

  console.log(`Mode : API REST (${baseUrl})`);
  console.log(`Période : ${dateStart} → ${dateEnd}\n`);

  const rows = await fetchAllPages(baseUrl, apiKey, 'accountancy/bookkeeping', {
    date_start: dateStart,
    date_end:   dateEnd,
  });
  console.log(`  ${rows.length} lignes récupérées`);
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { start, end, forceDb, forceApi } = parseArgs();
  const company   = loadCompany();
  const dateStart = start || company.fiscal_year.start;
  const dateEnd   = end   || company.fiscal_year.end;

  let rows;

  if (forceDb) {
    rows = await fetchViaDB(dateStart, dateEnd);
  } else {
    // Tente l'API, bascule sur MySQL si le module n'est pas disponible
    try {
      rows = await fetchViaAPI(dateStart, dateEnd);
    } catch (err) {
      if (err.message === 'API_NOT_AVAILABLE' || forceApi === false) {
        console.log('API accountancy non disponible — bascule sur MySQL...\n');
        rows = await fetchViaDB(dateStart, dateEnd);
      } else {
        throw err;
      }
    }
  }

  if (rows.length === 0) {
    console.warn('\nAucune écriture trouvée pour cette période.');
    console.warn('Vérifiez que des écritures sont saisies dans Comptabilité > Grand livre.');
    process.exit(0);
  }

  const entries = groupIntoEntries(rows);
  printSummary(entries);

  const outPath = path.join(ROOT, 'data', 'journal-entries.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
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
