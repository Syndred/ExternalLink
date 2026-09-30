@echo off
cd /d "%~dp0"
node scripts/open-workbench.mjs
if errorlevel 1 pause
