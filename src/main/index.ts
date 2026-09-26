import { app, shell, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import { getVersions, triggerIPC, startDiagnostic, stopDiagnostic, sendDiagnosticCommand, checkForUpdate, openUpdateDownload, getCableSetupStatus, unlockDriver, installDriver } from "@/lib";
import { GetVersionsFn } from "@shared/types";

// Only the app's own page may drive the monitor: a dropped file or foreign
// URL must never inherit window.context and send UDS commands to the ECU.
const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url ?? "";
  const devUrl = is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
  return url.startsWith("file://") || (!!devUrl && url.startsWith(devUrl));
};

const untrusted = { started: false, ok: false, message: "Rejected: request did not come from the app window." };

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    vibrancy: "under-window",
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.on("closed", () => { void stopDiagnostic(); });

  // No in-window navigation: the dashboard is a single page.
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // A reload (crash recovery, Ctrl+R in dev) starts a fresh page that knows
  // nothing of the running session, so end it rather than orphan it.
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) void stopDiagnostic();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("com.electron");

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // IPC events
  ipcMain.handle(
    "getVersions",
    (_, ...args: Parameters<GetVersionsFn>) => getVersions(...args)
  );

  ipcMain.handle("triggerIPC", () => triggerIPC());

  ipcMain.handle("diagnostic:start", (event) =>
    isTrustedSender(event) ? startDiagnostic(event.sender) : untrusted
  );

  ipcMain.handle("diagnostic:stop", (event) =>
    isTrustedSender(event) ? stopDiagnostic() : untrusted
  );

  ipcMain.handle("diagnostic:command", (event, command) =>
    isTrustedSender(event) ? sendDiagnosticCommand(command) : untrusted
  );

  ipcMain.handle("update:check", () => checkForUpdate());

  ipcMain.handle("update:openDownload", (event) =>
    isTrustedSender(event) ? openUpdateDownload() : untrusted
  );

  // Setup probes spawn system tools, and install elevates: app window only.
  ipcMain.handle("cable:status", (event, options) => {
    if (!isTrustedSender(event)) throw new Error(untrusted.message);
    return getCableSetupStatus({ full: options?.full === true });
  });

  ipcMain.handle("cable:unlockDriver", (event, passkey) =>
    isTrustedSender(event)
      ? unlockDriver(passkey)
      : { ok: false, reason: "unavailable", message: untrusted.message }
  );

  ipcMain.handle("cable:installDriver", (event) =>
    isTrustedSender(event)
      ? installDriver()
      : { ok: false, reason: "unavailable", message: untrusted.message }
  );
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopDiagnostic().finally(() => app.quit());
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
