# SiYuan GitHub Sync Plugin

Synchronisez vos notes SiYuan avec un dépôt GitHub privé via l'API REST GitHub. Compatible **Windows, Linux, macOS et Android**.

## Fonctionnalités

- 🔒 **Sécurisé** — Token stocké localement via `saveData()`
- 📤 **Push incrémental** — Envoie uniquement les fichiers modifiés
- 📥 **Pull incrémental** — Récupère les fichiers distants modifiés
- 🤝 **Merge automatique** — Fusion 3-way avant push (local / distant / dernier état connu)
- ⚠️ **Gestion des conflits** — Priorité locale en cas de conflit
- 📜 **Historique** — Consulte les 30 derniers commits
- 🔄 **Restauration** — Restaure un commit depuis l'historique
- 📋 **Diff avant push** — Affiche les fichiers ajoutés/modifiés/supprimés avant d'envoyer
- 🤖 **Groq AI** — Messages de commit générés automatiquement (optionnel)
- 📤📥 **Export/Import** — Sauvegarde et restaure la configuration

## Installation

### Depuis le dossier compilé

Copie le dossier `dist/` ou le dossier compilé dans :
```
{siyuan-workspace}/data/plugins/siyuan-github-sync/
```

Puis redémarre SiYuan et active le plugin dans **Paramètres → Marketplace → Installé**.

### Build depuis les sources

```bash
npm install
npm run build
```

Le dossier `dist/` sera créé. Copie-le dans le dossier `data/plugins/` de SiYuan.

### Sur mobile Android

Utilise un gestionnaire de fichiers pour copier le dossier `siyuan-github-sync` dans `Android/data/com.example.siyuan/files/data/plugins/` (ou le chemin équivalent selon votre version).

## Configuration

1. Ouvre **Paramètres** → clique sur ⚙️ à côté de "GitHub Sync"
2. Renseigne **Nom d'utilisateur GitHub**, **Nom du dépôt**, **Token PAT** (scope `repo`)
3. Clique sur **Tester GitHub** pour vérifier la connexion
4. Appuie sur **Enregistrer**

## Développement

```bash
npm run dev    # Mode watch
./compile.sh   # Build + déploiement automatique vers SiYuan (Linux)
```

## Licence

MIT
