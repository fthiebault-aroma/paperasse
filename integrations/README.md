# Intégrations

Connecteurs pour récupérer automatiquement les transactions bancaires et les opérations de paiement.

## Connecteurs disponibles

| Connecteur | Description | Env vars requises |
|------------|-------------|-------------------|
| [Qonto](qonto/) | Transactions bancaires via l'API Qonto | `QONTO_ID`, `QONTO_API_SECRET` |
| [Stripe](stripe/) | Charges, payouts, fees via l'API Stripe | Variable par compte (configurable) |
| [Dolibarr](dolibarr/) | Écritures comptables du grand livre via l'API Dolibarr → génère `data/journal-entries.json` pour le bilan et compte de résultat | `DOLAPIKEY`, `DOLIBARR_URL` |

## Configuration

### Qonto

1. Dans votre dashboard Qonto : **Settings > Integrations > API**
2. Notez votre Organization slug et votre Secret key
3. Définissez les variables d'environnement :
   ```bash
   export QONTO_ID="votre-organisation"
   export QONTO_API_SECRET="votre-secret"
   ```
4. Activez Qonto dans `company.json` :
   ```json
   "qonto": {
     "enabled": true
   }
   ```

### Stripe

#### Compte unique ou comptes séparés

Le cas le plus courant. Chaque compte Stripe a sa propre clé API.

1. Dans votre dashboard Stripe : **Developers > API keys**
2. Copiez votre Secret key (commence par `sk_live_` ou `sk_test_`)
3. Configurez vos comptes dans `company.json` :
   ```json
   "stripe_accounts": [
     { "id": "main", "name": "Mon Produit", "env_key": "STRIPE_SECRET" }
   ]
   ```
4. Définissez la variable d'environnement :
   ```bash
   export STRIPE_SECRET="sk_live_..."
   ```

Si vous avez plusieurs produits Stripe (comptes séparés), ajoutez une entrée par compte avec un `env_key` différent.

#### Stripe Connect (organisation avec sous-comptes)

Si vous utilisez Stripe Connect (un compte plateforme avec des comptes connectés), ajoutez le `stripe_account_id` (le `acct_xxx` du sous-compte) :

```json
"stripe_accounts": [
  { "id": "client-a", "name": "Client A", "env_key": "STRIPE_PLATFORM_SECRET", "stripe_account_id": "acct_xxx" },
  { "id": "client-b", "name": "Client B", "env_key": "STRIPE_PLATFORM_SECRET", "stripe_account_id": "acct_yyy" }
]
```

Tous les sous-comptes peuvent partager la même clé plateforme (`env_key`). Le connecteur envoie automatiquement le header `Stripe-Account` pour agir au nom de chaque sous-compte.

Vous pouvez mixer les deux modes (comptes séparés + Connect) dans le même tableau.

### Dolibarr

1. Dans votre Dolibarr : **Accueil > Réglages > Sécurité > Accès aux services web/API** — activez l'API REST et copiez votre clé API
2. Assurez-vous que vos écritures sont saisies dans le module **Comptabilité > Grand livre**
3. Définissez les variables d'environnement :
   ```bash
   export DOLAPIKEY="votre-cle-api"
   export DOLIBARR_URL="https://dolibarr.example.com"
   ```
4. Optionnellement, ajoutez dans `company.json` :
   ```json
   "dolibarr": {
     "url": "https://dolibarr.example.com"
   }
   ```
   (Si `DOLIBARR_URL` n'est pas défini en variable d'environnement, l'URL est lue ici.)

## Usage

```bash
# Qonto : récupérer toutes les transactions
npm run fetch:qonto

# Qonto : filtrer par date
node integrations/qonto/fetch.js --start 2025-01-01 --end 2025-12-31

# Stripe : récupérer tous les comptes
npm run fetch:stripe

# Stripe : filtrer par date et compte
node integrations/stripe/fetch.js --start 2025-01-01 --end 2025-12-31 --account main

# Dolibarr : récupérer les écritures (période fiscale de company.json)
node integrations/dolibarr/fetch.js

# Dolibarr : filtrer par date ou année
node integrations/dolibarr/fetch.js --start 2025-01-01 --end 2025-12-31
node integrations/dolibarr/fetch.js --year 2025

# Générer bilan + compte de résultat après le fetch Dolibarr
node scripts/generate-statements.js

# Tout récupérer
npm run fetch
```

## Format de sortie

Les transactions sont enregistrées dans `data/transactions/` au format JSON.

Chaque transaction suit le format standard Paperasse :

```json
{
  "id": "txn_xxx",
  "source": "qonto",
  "date": "2025-03-15T10:30:00Z",
  "amount": -45.99,
  "currency": "EUR",
  "label": "Amazon Web Services",
  "our_category": null,
  "raw": { ... }
}
```

Le champ `our_category` est rempli par le skill `comptable` lors de la catégorisation (mappage vendor vers compte PCG).

## Sécurité

Les clés API ne sont jamais stockées dans le repo. Elles sont lues depuis les variables d'environnement au moment de l'exécution. Ne commitez jamais de fichier `.env` contenant des secrets.
