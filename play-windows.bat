@echo off
rem Double-click to play on Windows.
rem ASCII only on purpose: cmd.exe garbles Korean text in batch files, so the
rem Korean messages live in scripts\launch.mjs (Node prints them correctly).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install "Node.js 22 LTS" ^(Windows .msi^) from the page that opens, then double-click this file again.
  start "" "https://nodejs.org/ko/download"
  pause
  exit /b 1
)

node scripts\launch.mjs
if errorlevel 1 pause
