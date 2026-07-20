@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title SiYuan GitHub Sync - Compilation et Déploiement

:: ─── Configuration ─────────────────────────────────────────────────────────
set "PLUGIN_NAME=siyuan-github-sync"
set "DEPLOY_DIR=C:\Users\Cyprien\Documents\siyuan\data\plugins\%PLUGIN_NAME%"
set "SCRIPT_DIR=%~dp0"

:: Supprimer le backslash final si présent
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo ┌──────────────────────────────────────────────────┐
echo │     SiYuan GitHub Sync  -  Build ^& Deploy       │
echo └──────────────────────────────────────────────────┘
echo.

:: ─── Etape 1 : Installation des dépendances ────────────────────────────────
echo [1/3]  Vérification des dépendances npm...
if not exist "%SCRIPT_DIR%\node_modules" (
    echo        Installation des modules (première fois)...
    call npm install
) else (
    echo        Modules déjà présents, passage à la compilation.
)
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR]  npm install a échoué.
    pause
    exit /b 1
)
echo.
echo        OK - Dépendances prêtes.
echo.

:: ─── Etape 2 : Compilation production ─────────────────────────────────────
echo [2/3]  Compilation en mode production...
echo.
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR]  La compilation a échoué.
    pause
    exit /b 1
)
echo.
echo        OK - Compilation réussie.
echo.

:: ─── Etape 3 : Déploiement dans SiYuan ────────────────────────────────────
echo [3/3]  Déploiement vers : %DEPLOY_DIR%
echo.

:: Créer le dossier cible s'il n'existe pas
if not exist "%DEPLOY_DIR%" (
    mkdir "%DEPLOY_DIR%" 2>nul
)

:: Vider le dossier cible (copie propre)
echo        Nettoyage du dossier cible...
rd /s /q "%DEPLOY_DIR%" 2>nul
mkdir "%DEPLOY_DIR%"

:: Copier le contenu de dist\ vers le dossier plugin
echo        Copie des fichiers compilés...
xcopy /s /e /y /q "%SCRIPT_DIR%\dist\*" "%DEPLOY_DIR%\"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR]  La copie des fichiers a échoué.
    pause
    exit /b 1
)

echo.
echo        OK - Plugin déployé avec succès.
echo.

:: ─── Nettoyage léger ──────────────────────────────────────────────────────
if exist "%SCRIPT_DIR%\dist" (
    rd /s /q "%SCRIPT_DIR%\dist"
)

echo ┌──────────────────────────────────────────────────┐
echo │   TERMINÉ !  Plugin installé dans SiYuan.        │
echo │                                                  │
echo │   Redémarrez SiYuan pour charger le plugin.      │
echo └──────────────────────────────────────────────────┘
echo.
echo   Chemin : %DEPLOY_DIR%
echo.
pause
