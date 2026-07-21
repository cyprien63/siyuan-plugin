@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title SiYuan GitHub Sync - Compilation et Déploiement

:: ─── Mode ──────────────────────────────────────────────────────────────────────
:: Usage: compile.bat           → test (déploiement dans SiYuan)
::        compile.bat publish   → publie (package.zip + rien d'autre)
set "MODE=%1"
if "%MODE%"=="" set "MODE=test"

set "PLUGIN_NAME=siyuan-github-sync"
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo ┌──────────────────────────────────────────────────┐
if "%MODE%"=="publish" (
    echo │   SiYuan GitHub Sync  -  Publication (release)  │
) else (
    echo │     SiYuan GitHub Sync  -  Build ^& Deploy       │
)
echo └──────────────────────────────────────────────────┘
echo.

:: ─── Etape 1 : Dépendances ────────────────────────────────────────────────────
echo [1/3]  Vérification des dépendances npm...
if not exist "%SCRIPT_DIR%\node_modules" (
    echo        Installation des modules...
    call npm install
)
echo        OK - Dépendances prêtes.
echo.

:: ─── Etape 2 : Compilation ────────────────────────────────────────────────────
echo [2/3]  Compilation...
echo.
call npm run build
echo        OK - Compilation réussie.
echo.

:: ─── Etape 3 : Résultat ───────────────────────────────────────────────────────
if "%MODE%"=="publish" (
    :: Mode publication : créer package.zip dans dist\
    cd /d "%SCRIPT_DIR%"
    if exist "dist\package.zip" del "dist\package.zip"
    cd dist
    ..\node_modules\.bin\bestzip package.zip * 2>nul || powershell Compress-Archive -Path * -DestinationPath package.zip
    cd ..
    echo        OK - package.zip créé dans dist\
    echo.
    echo ┌──────────────────────────────────────────────────┐
    echo │   PRET POUR LA RELEASE                           │
    echo │                                                  │
    echo │   Upload dist\package.zip sur GitHub Release     │
    echo └──────────────────────────────────────────────────┘
    echo.
    echo   Fichier : %SCRIPT_DIR%\dist\package.zip
    echo.
) else (
    :: Mode test : déploiement dans SiYuan
    set "DEPLOY_DIR=%USERPROFILE%\Documents\siyuan\data\plugins\%PLUGIN_NAME%"
    echo [3/3]  Déploiement vers : !DEPLOY_DIR!
    echo.
    if not exist "!DEPLOY_DIR!" mkdir "!DEPLOY_DIR!" 2>nul
    rd /s /q "!DEPLOY_DIR!" 2>nul
    mkdir "!DEPLOY_DIR!"
    xcopy /s /e /y /q "%SCRIPT_DIR%\dist\*" "!DEPLOY_DIR!\"
    echo        OK - Plugin déployé.
    echo.
    if exist "%SCRIPT_DIR%\dist" rd /s /q "%SCRIPT_DIR%\dist"
    echo ┌──────────────────────────────────────────────────┐
    echo │   TERMINE ! Plugin installé dans SiYuan.         │
    echo │                                                  │
    echo │   Redemarre SiYuan pour charger le plugin.       │
    echo └──────────────────────────────────────────────────┘
    echo.
    echo   Chemin : !DEPLOY_DIR!
    echo.
)
pause
