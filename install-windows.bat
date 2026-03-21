@echo off
REM ============================================================
REM Lumina FX — Windows Installer
REM ============================================================
REM Double-click to install Lumina FX on Windows
REM ============================================================

title Lumina FX Installer
color 0F

echo.
echo  ========================================
echo       Lumina FX Installer - Windows
echo              v0.5.0
echo  ========================================
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\Lumina FX"
set "DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\Lumina FX.lnk"
set "START_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Lumina FX.lnk"
set "PORT=3457"
set "GITHUB_REPO=https://github.com/shtarkair/lumina-mini.git"

REM ---- Check for Node.js ----
echo [1/5] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  Node.js is not installed.
    echo  Downloading Node.js installer...
    echo.

    REM Download Node.js LTS
    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile '%TEMP%\node-installer.msi' }"

    if not exist "%TEMP%\node-installer.msi" (
        echo  ERROR: Failed to download Node.js.
        echo  Please install Node.js manually from https://nodejs.org
        pause
        exit /b 1
    )

    echo  Installing Node.js...
    msiexec /i "%TEMP%\node-installer.msi" /qn /norestart

    REM Refresh PATH
    set "PATH=%PATH%;C:\Program Files\nodejs"

    where node >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo  ERROR: Node.js installation may require a restart.
        echo  Please restart your computer and run this installer again.
        pause
        exit /b 1
    )

    echo  Node.js installed successfully.
) else (
    for /f "tokens=*" %%v in ('node --version') do echo  Found Node.js %%v
)

REM ---- Check for Git ----
echo [2/5] Checking Git...
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  Git is not installed.
    echo  Downloading Git installer...
    echo.

    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe' -OutFile '%TEMP%\git-installer.exe' }"

    if not exist "%TEMP%\git-installer.exe" (
        echo  ERROR: Failed to download Git.
        echo  Please install Git manually from https://git-scm.com
        pause
        exit /b 1
    )

    echo  Installing Git (silent)...
    "%TEMP%\git-installer.exe" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="icons,ext\reg\shellhere,assoc,assoc_sh"

    set "PATH=%PATH%;C:\Program Files\Git\cmd"
)
echo  Git OK

REM ---- Clone or update project ----
echo [3/5] Installing Lumina FX...

if exist "%INSTALL_DIR%\lighting-server.js" (
    echo  Updating existing installation...
    cd /d "%INSTALL_DIR%"
    git pull origin main 2>nul || (
        echo  Update failed, doing fresh install...
        cd /d "%LOCALAPPDATA%"
        rmdir /s /q "Lumina FX" 2>nul
        git clone "%GITHUB_REPO%" "Lumina FX"
    )
) else (
    echo  Downloading from GitHub...
    cd /d "%LOCALAPPDATA%"
    rmdir /s /q "Lumina FX" 2>nul
    git clone "%GITHUB_REPO%" "Lumina FX"
)

if not exist "%INSTALL_DIR%\lighting-server.js" (
    echo  ERROR: Failed to download Lumina FX.
    echo  Please check your internet connection.
    pause
    exit /b 1
)

REM ---- Install dependencies ----
echo [4/5] Installing dependencies...
cd /d "%INSTALL_DIR%"
call npm install --production 2>nul
if %ERRORLEVEL% neq 0 (
    echo  Warning: npm install had issues. Retrying...
    call npm install --production
)

REM ---- Create launcher batch file ----
echo [5/5] Creating shortcuts...

REM Create the launcher script
(
echo @echo off
echo title Lumina FX
echo cd /d "%INSTALL_DIR%"
echo echo Starting Lumina FX...
echo echo.
echo.
echo REM Kill any existing instance
echo taskkill /f /im "node.exe" /fi "WINDOWTITLE eq Lumina FX" 2^>nul
echo.
echo REM Start server
echo start /min "Lumina FX Server" node lighting-server.js
echo.
echo REM Wait for server
echo timeout /t 3 /nobreak ^>nul
echo.
echo REM Open browser
echo start http://localhost:3457
echo.
echo echo Lumina FX is running on http://localhost:3457
echo echo Close this window to stop the server.
echo echo.
echo pause
echo taskkill /f /fi "WINDOWTITLE eq Lumina FX Server" 2^>nul
) > "%INSTALL_DIR%\Lumina FX.bat"

REM Create Desktop shortcut using PowerShell
powershell -Command "& { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP_SHORTCUT%'); $s.TargetPath = '%INSTALL_DIR%\Lumina FX.bat'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.IconLocation = 'shell32.dll,13'; $s.Description = 'Lumina FX - Lighting Effects Calculator'; $s.Save() }"

REM Create Start Menu shortcut
powershell -Command "& { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%START_SHORTCUT%'); $s.TargetPath = '%INSTALL_DIR%\Lumina FX.bat'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.IconLocation = 'shell32.dll,13'; $s.Description = 'Lumina FX - Lighting Effects Calculator'; $s.Save() }"

REM Create shows directory
if not exist "%USERPROFILE%\Documents\Lumina Shows" mkdir "%USERPROFILE%\Documents\Lumina Shows"

REM ---- Create uninstaller ----
(
echo @echo off
echo title Lumina FX Uninstaller
echo echo.
echo echo  ========================================
echo echo       Lumina FX Uninstaller
echo echo  ========================================
echo echo.
echo.
echo REM Stop server
echo taskkill /f /im "node.exe" /fi "WINDOWTITLE eq Lumina FX" 2^>nul
echo.
echo REM Remove app
echo echo Removing Lumina FX...
echo rmdir /s /q "%INSTALL_DIR%" 2^>nul
echo.
echo REM Remove shortcuts
echo del "%DESKTOP_SHORTCUT%" 2^>nul
echo del "%START_SHORTCUT%" 2^>nul
echo.
echo echo.
echo echo Lumina FX has been uninstalled.
echo echo Your show files in Documents\Lumina Shows were NOT removed.
echo echo.
echo pause
) > "%INSTALL_DIR%\Uninstall Lumina FX.bat"

echo.
echo  ========================================
echo       Installation Complete!
echo  ========================================
echo.
echo  Installed to: %INSTALL_DIR%
echo.
echo  - Desktop shortcut created
echo  - Start Menu shortcut created
echo  - Shows folder: %USERPROFILE%\Documents\Lumina Shows
echo.
echo  Double-click "Lumina FX" on your Desktop to start!
echo.

REM Ask to launch now
set /p LAUNCH="  Launch Lumina FX now? (Y/n): "
if /i not "%LAUNCH%"=="n" (
    start "" "%INSTALL_DIR%\Lumina FX.bat"
)

pause
