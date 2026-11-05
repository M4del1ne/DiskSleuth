// Electron main process: frameless window with a custom title bar; starts the Go backend and hands its URL/token to the page.
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const devServerUrl = process.env.VITE_DEV_SERVER_URL

// ---------------- backend process ----------------
const backend = { url: null, token: null, error: null }
let backendProc = null

function startBackend() {
  const exe = process.env.DS_BACKEND_EXE || path.join(__dirname, '..', '..', 'build', 'bin', 'disksleuth-server.exe')
  return new Promise((resolve) => {
    if (!fs.existsSync(exe)) {
      backend.error = `backend executable not found: ${exe} (run scripts\\build-backend.ps1 first)`
      return resolve()
    }
    backendProc = spawn(exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { backend.error = 'backend start timed out'; resolve() }, 15000)
    // the first stdout line is {"event":"ready","url":…,"token":…}
    backendProc.stdout.on('data', (d) => {
      if (backend.url) return
      buf += d.toString('utf8')
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const m = JSON.parse(buf.slice(0, i))
        if (m.event === 'ready') { backend.url = m.url; backend.token = m.token }
      } catch {
        backend.error = 'unexpected backend output'
      }
      done()
    })
    backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
    backendProc.on('exit', (code) => {
      backendProc = null
      if (!backend.url) { backend.error = `backend process exited (code ${code})`; done() }
    })
  })
}
const backendReady = startBackend()

ipcMain.handle('backend:info', async () => { await backendReady; return backend })
// clipboard through the main process: works even when the page does not have focus
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true })
ipcMain.handle('dialog:open-evidence', async (e, multi) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Select evidence images',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [
      { name: 'Disk images', extensions: ['E01', 'e01', 'Ex01', 'dd', 'raw', 'img', '001', 'bin'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (r.canceled) return null
  return multi ? r.filePaths : r.filePaths[0]
})
// destination folder for exports
ipcMain.handle('dialog:choose-folder', async (e, defaultPath) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'Choose a folder',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory'],
  })
  return r.canceled ? null : r.filePaths[0]
})
// open an export folder, or show an exported file (report) in Explorer; only existing local paths
ipcMain.handle('shell:show', async (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) return false
  if (fs.statSync(p).isDirectory()) return (await shell.openPath(p)) === ''
  shell.showItemInFolder(p)
  return true
})

// ---------------- window ----------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    frame: false,
    show: false,
    backgroundColor: '#f3f4f6',
    title: 'DiskSleuth',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  const sendMax = () => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)

  // open external links in the system browser, never in a new app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('window:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  w.isMaximized() ? w.unmaximize() : w.maximize()
})
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.handle('window:is-maximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => { backendProc?.kill() })
