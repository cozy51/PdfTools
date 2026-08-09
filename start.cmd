@echo off
rem PDF Tools をローカルサーバーで開くための起動ファイル（このファイルをダブルクリック）
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title PDF Tools

set "PYCMD="
py -3 -c "pass" >nul 2>&1 && set "PYCMD=py -3"
if not defined PYCMD (
  python -c "pass" >nul 2>&1 && set "PYCMD=python"
)
if not defined PYCMD (
  python3 -c "pass" >nul 2>&1 && set "PYCMD=python3"
)

if not defined PYCMD (
  echo Python が見つかりませんでした。
  echo Python 3 をインストールしてから、もう一度このファイルを実行してください。
  echo   https://www.python.org/downloads/windows/
  echo.
  echo Python を使わない場合は、このフォルダーを静的ホスティングへ配置するか、
  echo 別の HTTP サーバーで配信してからブラウザーで開いてください。
  echo.
  pause
  exit /b 1
)

%PYCMD% "%~dp0serve.py" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo 起動に失敗しました。上のメッセージを確認してください。
  pause
)
exit /b %EXITCODE%
