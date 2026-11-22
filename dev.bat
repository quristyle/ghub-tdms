@echo off
rem
rem  GHub TDMS - Windows entry point.
rem
rem    dev.bat              browser control panel
rem    dev.bat tui          terminal control panel
rem    dev.bat start        start everything
rem    dev.bat help         full command list (in Korean, printed by dev.sh)
rem
rem  All this file does is find Git Bash and hand the arguments to dev.sh.
rem  No decision logic lives here - a second copy would drift, and the browser
rem  panel (devctl/server/panel.mjs) calls dev.sh too. Windows/Linux differences
rem  are absorbed in devctl/lib/compat.sh and nowhere else.
rem
rem  ===================================================================
rem  KEEP THIS FILE PURE ASCII. Do not put Korean (or any non-ASCII) in it.
rem
rem  cmd.exe resumes a batch file from a stored BYTE offset, and `chcp` below
rem  changes how it counts those bytes. With multi-byte text above, the offset
rem  lands mid-character and cmd starts executing the middle of a comment -
rem  e.g. "rem dev.bat tui" became the command `ui`, over and over.
rem  Korean user-facing text belongs in dev.sh, which bash reads, not cmd.
rem  ===================================================================
rem

setlocal EnableExtensions
set "RC=1"

rem  Put the console in UTF-8 so dev.sh's Korean output is readable,
rem  and put it back on the way out.
for /f "tokens=2 delims=:" %%C in ('chcp') do set "OLDCP=%%C"
set "OLDCP=%OLDCP: =%"
set "OLDCP=%OLDCP:.=%"
if not defined OLDCP set "OLDCP=949"
>nul chcp 65001

cd /d "%~dp0"

rem  Find Git Bash.
rem
rem  `where bash` is deliberately NOT used: C:\Windows\System32\bash.exe (the
rem  WSL launcher) wins that search, and dev.sh would then run in a Linux shell
rem  that cannot see this drive. Probe the install locations instead.
set "BASH="
if defined TDMS_BASH call :find "%TDMS_BASH%"
call :find "%ProgramFiles%\Git\bin\bash.exe"
call :find "%ProgramW6432%\Git\bin\bash.exe"
call :find "%ProgramFiles(x86)%\Git\bin\bash.exe"
call :find "%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH (
  rem  git.exe sits in ...\Git\cmd\ or ...\Git\bin\ - ..\bin\bash.exe covers both
  for /f "delims=" %%G in ('where git 2^>nul') do call :find "%%~dpG..\bin\bash.exe"
)

if not defined BASH (
  echo.
  echo   Git Bash not found.
  echo.
  echo   Install Git for Windows:
  echo     winget install Git.Git
  echo.
  echo   Already installed elsewhere? Point at it:
  echo     set TDMS_BASH=D:\Git\bin\bash.exe
  echo.
  goto :done
)

if not exist "dev.sh" (
  echo.
  echo   dev.sh not found - run this from inside the repository.
  echo.
  goto :done
)

"%BASH%" dev.sh %*
set "RC=%ERRORLEVEL%"

:done
>nul chcp %OLDCP%
endlocal & exit /b %RC%

rem  Skip once found. %~f1 resolves the ..\ in the git.exe probe above.
:find
if defined BASH goto :eof
if exist "%~f1" set "BASH=%~f1"
goto :eof
