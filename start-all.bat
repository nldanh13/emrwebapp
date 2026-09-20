@echo off
setlocal
cd /d "%~dp0"

REM Bat song song: (1) server chinh emrwebapp (npm start) va (2) cong cu
REM tools/bhyt_selenium_app (nhap/sua len cong BHXH) — moi cai 1 cua so
REM console rieng de doc log/dung tung phan doc lap. Chi danh cho truong
REM hop 2 phan cung chay tren 1 may Windows; neu emrwebapp chay o server
REM khac (khong phai may ban dang ngoi), dung script nay — chi bat rieng
REM tools\bhyt_selenium_app\start.bat tren dung may co Chrome.

where npm >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay npm. Hay cai Node.js roi chay lai.
  pause
  exit /b 1
)
if not exist "tools\bhyt_selenium_app\start.bat" (
  echo Khong thay tools\bhyt_selenium_app\start.bat - kiem tra lai vi tri repo.
  pause
  exit /b 1
)

echo Dang mo 2 cua so: "EMR Web App" (cong 3001) va "BHYT Selenium" (cong 5005)...
start "EMR Web App" cmd /k "cd /d "%~dp0" && npm start"
start "BHYT Selenium (Nghi om)" cmd /k "cd /d "%~dp0tools\bhyt_selenium_app" && start.bat"

echo Da mo 2 cua so rieng. Dong cua so nay khong lam tat 2 server tren.
echo Muon dung: dong tung cua so console tuong ung (hoac Ctrl+C trong do).
pause
