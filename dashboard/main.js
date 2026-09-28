const { app, BrowserWindow, Tray, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let tray;
let serverProcess;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'public', 'icon.png')
    });

    // Start the Express server
    serverProcess = spawn('node', [path.join(__dirname, 'server.js')], {
        stdio: 'inherit'
    });

    // Wait for server to start then load dashboard
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:3000');
    }, 2000);

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (serverProcess) {
            serverProcess.kill();
        }
    });
}

function createTray() {
    tray = new Tray(path.join(__dirname, 'public', 'icon.png'));
    
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Dashboard', click: () => mainWindow?.show() },
        { label: 'Quit', click: () => app.quit() }
    ]);

    tray.setToolTip('Employee Monitoring Dashboard');
    tray.setContextMenu(contextMenu);
    
    tray.on('double-click', () => {
        mainWindow?.show();
    });
}

app.whenReady().then(() => {
    createWindow();
    createTray();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
