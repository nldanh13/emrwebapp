@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay Python. Hay cai Python 3.11 tro len va chon Add Python to PATH.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Dang tao moi truong Python...
  python -m venv .venv
  if errorlevel 1 goto :error
)
call ".venv\Scripts\activate.bat"
python -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :error
echo Cong cu nhap cong BHXH dang chay. Thao tac o tab Nghi om cua web app (khong can mo trang rieng).
echo Khong dong cua so nay trong khi nhap lieu. Nhan Ctrl+C de dung.
python app.py
exit /b %errorlevel%
:error
echo Khoi dong that bai. Xem thong bao loi o phia tren.
pause
exit /b 1
