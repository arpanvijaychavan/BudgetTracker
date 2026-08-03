@echo off
cd /d "%~dp0"

powershell -NoProfile -Command ^
  "$already = $false; try { (New-Object Net.Sockets.TcpClient('localhost', 8000)).Close(); $already = $true } catch {}; if ($already) { Start-Process 'http://localhost:8000'; exit 0 } else { exit 1 }"

if %errorlevel%==0 goto :eof

"C:\Users\hpo1753\AppData\Local\Python\pythoncore-3.14-64\python.exe" -c "import pandas, openpyxl" 2>nul
if not %errorlevel%==0 (
  echo Dependencies missing or broken - reinstalling pandas/openpyxl...
  "C:\Users\hpo1753\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m pip install --user pandas openpyxl
)

start "Budget Tracker Server" cmd /k ""C:\Users\hpo1753\AppData\Local\Python\pythoncore-3.14-64\python.exe" server.py"

powershell -NoProfile -Command ^
  "$ok = $false; for ($i = 0; $i -lt 40; $i++) { try { (New-Object Net.Sockets.TcpClient('localhost', 8000)).Close(); $ok = $true; break } catch { Start-Sleep -Milliseconds 500 } }; if ($ok) { Start-Process 'http://localhost:8000' } else { Write-Host 'Server did not start within 20 seconds - check the "Budget Tracker Server" window for errors.'; Start-Sleep -Seconds 5 }"
