@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set DOTNET_CLI_TELEMETRY_OPTOUT=1
set DOTNET_NOLOGO=1
set DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

echo ============================================================
echo  PlacemakerCore  -  Route B proof of concept
echo  compiling 465 Core files against the local math shim
echo ============================================================
echo.

where dotnet >nul 2>nul
if errorlevel 1 (
  echo [FATAL] "dotnet" not found on PATH.
  echo         Requires .NET SDK 6.0 or newer.
  echo.
  pause
  exit /b 2
)

echo === [1/5] build PlacemakerCore ===
dotnet build PlacemakerCore.csproj -c Release -nologo -v:m -m:1 -nodeReuse:false > build.log 2>&1
if errorlevel 1 goto failed

echo === [2/5] build and run SelfTest ===
dotnet run --project SelfTest\SelfTest.csproj -c Release -nologo >> build.log 2>&1
if errorlevel 1 goto failed

echo === [3/5] plan driver: 7 road scenarios -^> out\plan-*.svg ===
dotnet run --project Driver\Driver.csproj -c Release -nologo -- "%CD%\out" --no-sweep >> build.log 2>&1
if errorlevel 1 goto failed

echo === [4/5] sweep: every [AreaGenerator] in 4 contexts -^> out\sweep\, sweep.md ===
dotnet run --project Driver\Driver.csproj -c Release --no-build -nologo -- "%CD%\out" --sweep >> build.log 2>&1
if errorlevel 1 goto failed

echo === [5/5] recipes: 13 nested cases + 69 shipped recipes -^> out\recipes\, recipes.md ===
dotnet run --project Driver\Driver.csproj -c Release --no-build -nologo -- "%CD%\out" --recipes >> build.log 2>&1
if errorlevel 1 goto failed

echo.
echo ============================================================
echo   ALL GREEN
echo   library compiles, self-test passed, 7 scenarios + 130 generators + 82 recipes rendered
echo   log:  "%CD%\build.log"
echo   svg:  "%CD%\out\plan-*.svg"  "%CD%\out\sweep\*.svg"  "%CD%\out\recipes\*.svg"
echo   index: "%CD%\out\sweep.md"  "%CD%\out\recipes.md"
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo ============================================================
echo   FAILED
echo   full log: "%CD%\build.log"
echo   error lines:
echo ============================================================
type build.log | findstr /C:"error " /C:"FAIL" /C:"Unhandled" /C:"Exception:"
echo.
echo ============================================================
pause
exit /b 1
