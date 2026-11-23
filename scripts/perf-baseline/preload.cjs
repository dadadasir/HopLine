const { contextBridge, ipcRenderer } = require('electron')
let sent = false
contextBridge.exposeInMainWorld('baselinePaint', () => {
  if (sent) return
  sent = true
  ipcRenderer.send('perf:first-paint')
})
