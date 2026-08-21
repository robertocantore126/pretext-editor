@echo off
setlocal
title pretext-editor - dev server
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo npm non trovato. Installa Node.js e riprova.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Prima installazione: scarico le dipendenze...
    call npm install
    if errorlevel 1 (
        echo Installazione fallita.
        pause
        exit /b 1
    )
)

echo.
echo Avvio del dev server su http://localhost:5190/ ... il browser si apre da solo.
echo Per fermarlo: premi Ctrl+C oppure chiudi questa finestra.
echo.
call npm run dev -- --port 5190 --open
echo.
echo Il server si e' fermato.
pause
