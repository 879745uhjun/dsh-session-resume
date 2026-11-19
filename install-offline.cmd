@echo off
rem Install dsh-session-resume with DSH closed, then start DSH again.
setlocal
set NODE=C:\Users\17589\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
if not exist "%NODE%" set NODE=node
"%NODE%" "%~dp0install-offline.mjs" %*
echo.
pause
