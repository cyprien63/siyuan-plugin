#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
PLUGIN_NAME="siyuan-github-sync"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Détection automatique du dossier SiYuan (Linux)
# Priorité : variable SIYUAN_WORKSPACE, sinon workspace.json, sinon chemin par défaut
if [ -n "${SIYUAN_WORKSPACE:-}" ]; then
    SIYUAN_DATA="$SIYUAN_WORKSPACE/data"
elif [ -f "$HOME/.config/siyuan/workspace.json" ]; then
    SIYUAN_DATA="$(grep -o '"[^"]*"' "$HOME/.config/siyuan/workspace.json" | head -1 | tr -d '"')/data"
else
    SIYUAN_DATA="$HOME/.config/siyuan/data"
fi
DEPLOY_DIR="$SIYUAN_DATA/plugins/$PLUGIN_NAME"

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}┌──────────────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│     SiYuan GitHub Sync  -  Build & Deploy       │${NC}"
echo -e "${CYAN}└──────────────────────────────────────────────────┘${NC}"
echo ""

# ─── Étape 1 : Installation des dépendances ────────────────────────────────
echo -e "[1/3]  Vérification des dépendances npm..."
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "       Installation des modules (première fois)..."
    cd "$SCRIPT_DIR" && npm install
else
    echo "       Modules déjà présents, passage à la compilation."
fi

if [ $? -ne 0 ]; then
    echo ""
    echo -e "${RED}[ERREUR]  npm install a échoué.${NC}"
    exit 1
fi
echo ""
echo -e "       ${GREEN}OK${NC} - Dépendances prêtes."
echo ""

# ─── Étape 2 : Compilation production ──────────────────────────────────────
echo -e "[2/3]  Compilation en mode production..."
echo ""
cd "$SCRIPT_DIR" && npm run build

if [ $? -ne 0 ]; then
    echo ""
    echo -e "${RED}[ERREUR]  La compilation a échoué.${NC}"
    exit 1
fi
echo ""
echo -e "       ${GREEN}OK${NC} - Compilation réussie."
echo ""

# ─── Étape 3 : Déploiement dans SiYuan ────────────────────────────────────
echo -e "[3/3]  Déploiement vers : ${YELLOW}$DEPLOY_DIR${NC}"
echo ""

# Créer le dossier cible s'il n'existe pas
mkdir -p "$DEPLOY_DIR"

# Vider le dossier cible (copie propre)
echo "       Nettoyage du dossier cible..."
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# Copier le contenu de dist/ vers le dossier plugin
echo "       Copie des fichiers compilés..."
cp -r "$SCRIPT_DIR/dist/"* "$DEPLOY_DIR/"

if [ $? -ne 0 ]; then
    echo ""
    echo -e "${RED}[ERREUR]  La copie des fichiers a échoué.${NC}"
    exit 1
fi

echo ""
echo -e "       ${GREEN}OK${NC} - Plugin déployé avec succès."
echo ""

# ─── Nettoyage léger ──────────────────────────────────────────────────────
if [ -d "$SCRIPT_DIR/dist" ]; then
    rm -rf "$SCRIPT_DIR/dist"
fi

echo -e "${CYAN}┌──────────────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│   TERMINÉ !  Plugin installé dans SiYuan.        │${NC}"
echo -e "${CYAN}│                                                  │${NC}"
echo -e "${CYAN}│   Redémarrez SiYuan pour charger le plugin.      │${NC}"
echo -e "${CYAN}└──────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "  Chemin : ${YELLOW}$DEPLOY_DIR${NC}"
echo ""
