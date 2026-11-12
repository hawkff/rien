import path from 'node:path';

import ErrorHtmlAsset from '@assets/error.html?asset';
import {
  enhanceWebRequest,
  type BetterSession,
} from '@jellybrick/electron-better-web-request';
import { deepmerge } from 'deepmerge-ts';
import {
  BrowserWindow,
  app,
  screen,
  globalShortcut,
  session,
  shell,
  dialog,
  ipcMain,
  protocol,
  type BrowserWindowConstructorOptions,
} from 'electron';
import electronDebug from 'electron-debug';
import is from 'electron-is';
import unhandled from 'electron-unhandled';
import { deepEqual } from 'fast-equals';
import { languageResources } from 'virtual:i18n';
import { allPlugins, mainPlugins } from 'virtual:plugins';

import * as config from '@/config';
import { APPLICATION_NAME, loadI18n, setLanguage, t } from '@/i18n';
import {
  forceLoadMainPlugin,
  forceUnloadMainPlugin,
  getAllLoadedMainPlugins,
  loadAllMainPlugins,
} from '@/loader/main';
import { refreshMenu, setApplicationMenu } from '@/menu';
import musicPlayerCss from '@/music-player.css?inline';
import { defaultAuthProxyConfig } from '@/plugins/auth-proxy-adapter/config';
import { fileExists, injectCSS, injectCSSAsFile } from '@/plugins/utils/main';
import { restart, setupAppControls } from '@/providers/app-controls';
import {
  APP_PROTOCOL,
  handleProtocol,
  setupProtocolHandler,
} from '@/providers/protocol-handler';
import {
  getRendererPluginScripts,
  getRendererScripts,
} from '@/providers/renderer-scripts';
import { setupSongInfo } from '@/providers/song-info';
import { setUpTray } from '@/tray';
import { LoggerPrefix } from '@/utils';
import {
  GUEST_SWITCH,
  guestTitle,
  removeGuestProfiles,
} from '@/utils/guest-profile';

import type { PluginConfig } from '@/types/plugins';

// Catch errors and log them
unhandled({
  logger: console.error,
  showDialog: false,
});

// Prevent window being garbage collected
let mainWindow: Electron.BrowserWindow | null;

// The lock is keyed to the userData folder. A guest takes the account's lock,
// so opening Rien again focuses the guest instead of starting the account.
const guestOf = app.commandLine.getSwitchValue(GUEST_SWITCH);
const ownProfile = app.getPath('userData');
if (guestOf) app.setPath('userData', guestOf);
const gotTheLock = app.requestSingleInstanceLock();
if (guestOf) app.setPath('userData', ownProfile);
if (!gotTheLock) {
  app.exit();
} else if (!guestOf) {
  removeGuestProfiles(app.getPath('temp'), ownProfile);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'http',
    privileges: {
      standard: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
  {
    scheme: 'https',
    privileges: {
      standard: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
  { scheme: 'mailto', privileges: { standard: true } },
]);

// Ozone platform hint: Required for Wayland support
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

// OverlayScrollbar: Required for overlay scrollbars
// UseOzonePlatform: Required for Wayland support
// WaylandWindowDecorations: Required for Wayland decorations
app.commandLine.appendSwitch(
  'enable-features',
  'OverlayScrollbar,UseOzonePlatform,WaylandWindowDecorations',
);

// Disable Fluent Scrollbar (for OverlayScrollbar)
const disabledFeatures = ['FluentScrollbar'];
let disableHardwareAcceleration = config.get(
  'options.disableHardwareAcceleration',
);

// Linux specific fixes
if (is.linux()) {
  // Stops chromium from launching its own MPRIS service
  if (await config.plugins.isEnabled('shortcuts')) {
    disabledFeatures.push('MediaSessionService');
  }

  // https://github.com/electron/electron/issues/15947
  if (await config.plugins.isEnabled('transparent-player')) {
    disableHardwareAcceleration = true;
    app.commandLine.appendSwitch('enable-transparent-visuals');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  }

  // Overrides WM_CLASS for X11 to correspond to icon filename
  app.setName('io.github.hawkff.rien');
  // for wayland
  app.commandLine.appendSwitch('class', 'io.github.hawkff.rien');
}

if (disableHardwareAcceleration) {
  if (is.dev()) console.log('Disabling hardware acceleration');
  app.disableHardwareAcceleration();
}

// Apply disabled features
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

if (config.get('options.proxy')) {
  const authProxyEnabled = await config.plugins.isEnabled('auth-proxy-adapter');

  let proxyToUse = '';
  if (authProxyEnabled) {
    // Use proxy from Auth-Proxy-Adapter plugin
    const authProxyConfig = deepmerge(
      defaultAuthProxyConfig,
      config.get('plugins.auth-proxy-adapter') ?? {},
    ) as typeof defaultAuthProxyConfig;

    const { hostname, port } = authProxyConfig;
    proxyToUse = `socks5://${hostname}:${port}`;
  } else if (config.get('options.proxy')) {
    // Use global proxy settings
    proxyToUse = config.get('options.proxy');
  }
  console.log(LoggerPrefix, `Using proxy: ${proxyToUse}`);
  app.commandLine.appendSwitch('proxy-server', proxyToUse);
}

// Adds debug features like hotkeys for triggering dev tools and reload
electronDebug({
  showDevTools: false, // Disable automatic devTools on new window
});

let icon = 'assets/icon.png';
if (process.platform === 'win32') {
  icon = 'assets/generated/icons/win/icon.ico';
} else if (process.platform === 'darwin') {
  icon = 'assets/generated/icons/mac/icon.icns';
}

function onClosed() {
  // Dereference the window
  // For multiple Windows store them in an array
  mainWindow = null;
}

ipcMain.handle('peard:get-main-plugin-names', async () =>
  Object.keys(await mainPlugins()),
);

// Pages outside the music site, such as Google's sign-in, get a button that
// leads to the last music page in the window's history.
ipcMain.on('peard:back-to-music', ({ sender }) => {
  const index = sender.navigationHistory
    .getAllEntries()
    .map((entry) => URL.parse(entry.url)?.hostname)
    .lastIndexOf('music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com');
  if (index >= 0) sender.navigationHistory.goToIndex(index);
  else sender.loadURL(config.defaultConfig.url);
});

const initHook = async (win: BrowserWindow) => {
  const allPluginStubs = await allPlugins();

  ipcMain.handle(
    'peard:get-config',
    (_, id: string) =>
      deepmerge(
        allPluginStubs[id].config ?? { enabled: false },
        config.get(`plugins.${id}`) ?? {},
      ) as PluginConfig,
  );
  ipcMain.handle('peard:set-config', (_, name: string, obj: object) =>
    config.setPartial(`plugins.${name}`, obj, allPluginStubs[name].config),
  );

  config.watch((newValue, oldValue) => {
    const newPluginConfigList = (newValue?.plugins ?? {}) as Record<
      string,
      unknown
    >;
    const oldPluginConfigList = (oldValue?.plugins ?? {}) as Record<
      string,
      unknown
    >;

    Object.entries(newPluginConfigList).forEach(([id, newPluginConfig]) => {
      const isEqual = deepEqual(oldPluginConfigList[id], newPluginConfig);

      if (!isEqual) {
        const oldConfig = oldPluginConfigList[id] as PluginConfig;
        const config = deepmerge(
          allPluginStubs[id].config ?? { enabled: false },
          newPluginConfig ?? {},
        ) as PluginConfig;

        if (config.enabled !== oldConfig?.enabled) {
          if (config.enabled) {
            win.webContents.send('plugin:enable', id);
            ipcMain.emit('plugin:enable', id);
            forceLoadMainPlugin(id, win);
          } else {
            win.webContents.send('plugin:unload', id);
            ipcMain.emit('plugin:unload', id);
            forceUnloadMainPlugin(id, win);
          }

          if (allPluginStubs[id]?.restartNeeded) {
            showNeedToRestartDialog(id);
          }
        }

        const mainPlugin = getAllLoadedMainPlugins()[id];
        if (mainPlugin) {
          if (config.enabled && typeof mainPlugin.backend !== 'function') {
            mainPlugin.backend?.onConfigChange?.call(
              mainPlugin.backend,
              config,
            );
          }
        }

        win.webContents.send('config-changed', id, config);
      }
    });
  });
};

const showNeedToRestartDialog = async (id: string) => {
  const plugin = (await allPlugins())[id];

  const dialogOptions: Electron.MessageBoxOptions = {
    type: 'info',
    buttons: [
      t('main.dialog.need-to-restart.buttons.restart-now'),
      t('main.dialog.need-to-restart.buttons.later'),
    ],
    title: t('main.dialog.need-to-restart.title'),
    message: t('main.dialog.need-to-restart.message', {
      pluginName: plugin?.name?.() ?? id,
    }),
    detail: t('main.dialog.need-to-restart.detail', {
      pluginName: plugin?.name?.() ?? id,
    }),
    defaultId: 0,
    cancelId: 1,
  };

  let dialogPromise: Promise<Electron.MessageBoxReturnValue>;
  if (mainWindow) {
    dialogPromise = dialog.showMessageBox(mainWindow, dialogOptions);
  } else {
    dialogPromise = dialog.showMessageBox(dialogOptions);
  }

  dialogPromise.then((dialogOutput) => {
    switch (dialogOutput.response) {
      case 0: {
        restart();
        break;
      }

      // Ignore
      default: {
        break;
      }
    }
  });
};

function initTheme(win: BrowserWindow) {
  injectCSS(win.webContents, musicPlayerCss);
  // Load user CSS
  const themes: string[] = config.get('options.themes');
  if (Array.isArray(themes)) {
    for (const cssFile of themes) {
      fileExists(
        cssFile,
        () => {
          injectCSSAsFile(win.webContents, cssFile);
        },
        () => {
          console.warn(
            LoggerPrefix,
            t('main.console.theme.css-file-not-found', { cssFile }),
          );
        },
      );
    }
  }

  win.webContents.once('did-finish-load', () => {
    if (is.dev()) {
      console.debug(LoggerPrefix, t('main.console.did-finish-load.dev-tools'));
      win.webContents.openDevTools();
    }
  });
}

async function createMainWindow() {
  const windowSize = config.get('window-size');
  const windowMaximized = config.get('window-maximized');
  const windowPosition: Electron.Point = config.get('window-position');
  const useInlineMenu = await config.plugins.isEnabled('in-app-menu');

  const defaultTitleBarOverlayOptions: Electron.TitleBarOverlay = {
    color: '#00000000',
    symbolColor: '#ffffff',
    height: 32,
  };

  const decorations: Partial<BrowserWindowConstructorOptions> = {
    frame: !is.macOS() && !useInlineMenu,
    titleBarOverlay: defaultTitleBarOverlayOptions,
    titleBarStyle: useInlineMenu
      ? 'hidden'
      : is.macOS()
        ? 'hiddenInset'
        : 'default',
    autoHideMenuBar: config.get('options.hideMenu'),
  };

  // Note: on linux, for some weird reason, having these extra properties with 'frame: false' does not work
  if (is.linux() && useInlineMenu) {
    delete decorations.titleBarOverlay;
    delete decorations.titleBarStyle;
  }

  const electronWindowSettings: Electron.BrowserWindowConstructorOptions = {
    icon,
    width: windowSize.width,
    height: windowSize.height,
    minWidth: 325,
    minHeight: 425,
    backgroundColor: '#000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      // The preload script uses Node modules, which a sandboxed one cannot.
      sandbox: false,
    },
    ...decorations,
  };

  const win = new BrowserWindow(electronWindowSettings);

  await initHook(win);
  initTheme(win);

  await loadAllMainPlugins(win);

  if (windowPosition) {
    const { x: windowX, y: windowY } = windowPosition;
    const winSize = win.getSize();
    const display = screen.getDisplayNearestPoint(windowPosition);
    const primaryDisplay = screen.getPrimaryDisplay();

    const scaleFactor = is.windows()
      ? primaryDisplay.scaleFactor / display.scaleFactor
      : 1;
    const scaledWidth = Math.floor(windowSize.width * scaleFactor);
    const scaledHeight = Math.floor(windowSize.height * scaleFactor);

    const scaledX = windowX;
    const scaledY = windowY;

    if (
      scaledX + scaledWidth / 2 < display.bounds.x - 8 || // Left
      scaledX + scaledWidth / 2 > display.bounds.x + display.bounds.width || // Right
      scaledY < display.bounds.y - 8 || // Top
      scaledY + scaledHeight / 2 > display.bounds.y + display.bounds.height // Bottom
    ) {
      // Window is offscreen
      if (is.dev()) {
        console.warn(
          LoggerPrefix,
          t('main.console.window.tried-to-render-offscreen', {
            windowSize: String(winSize),
            displaySize: JSON.stringify(display.bounds),
            position: JSON.stringify(windowPosition),
          }),
        );
      }
    } else {
      win.setSize(scaledWidth, scaledHeight);
      win.setPosition(scaledX, scaledY);
    }
  }

  if (windowMaximized) {
    win.maximize();
  }

  if (config.get('options.alwaysOnTop')) {
    win.setAlwaysOnTop(true);
  }

  const urlToLoad = config.get('options.resumeOnStart')
    ? config.get('url')
    : config.defaultConfig.url;
  win.on('closed', onClosed);

  win.on('move', () => {
    if (win.isMaximized()) {
      return;
    }

    const [x, y] = win.getPosition();
    lateSave('window-position', { x, y });
  });

  let winWasMaximized: boolean;

  win.on('resize', () => {
    const [width, height] = win.getSize();
    const isMaximized = win.isMaximized();

    if (winWasMaximized !== isMaximized) {
      winWasMaximized = isMaximized;
      config.set('window-maximized', isMaximized);
    }

    if (isMaximized) {
      return;
    }

    lateSave('window-size', {
      width,
      height,
    });
  });

  const savedTimeouts: Record<string, NodeJS.Timeout | undefined> = {};

  function lateSave(
    key: string,
    value: unknown,
    fn: (key: string, value: unknown) => void = config.set,
  ) {
    if (savedTimeouts[key]) {
      clearTimeout(savedTimeouts[key]);
    }

    savedTimeouts[key] = setTimeout(() => {
      fn(key, value);
      savedTimeouts[key] = undefined;
    }, 600);
  }

  app.on('render-process-gone', (_event, _webContents, details) => {
    showUnresponsiveDialog(win, details);
  });

  win.once('ready-to-show', () => {
    if (config.get('options.appVisible')) {
      win.show();
    }
  });

  removeContentSecurityPolicy();

  win.webContents.on('dom-ready', () => {
    if (useInlineMenu && is.windows()) {
      win.setTitleBarOverlay({
        ...defaultTitleBarOverlayOptions,
        height: Math.floor(
          defaultTitleBarOverlayOptions.height! *
            win.webContents.getZoomFactor(),
        ),
      });
    }
  });
  win.webContents.on('will-redirect', (event) => {
    const url = URL.parse(event.url);

    // Workarounds for regions where YTM is restricted
    if (
      url &&
      url.hostname.endsWith('\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com') &&
      url.pathname === '/premium'
    ) {
      event.preventDefault();

      win.webContents.loadURL(
        'https://accounts.google.com/ServiceLogin?ltmpl=music&service=\u0079\u006f\u0075\u0074\u0075\u0062\u0065&continue=https%3A%2F%2Fwww.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com%252F',
      );
    }
  });

  win.webContents.loadURL(urlToLoad);

  return win;
}

app.once('browser-window-created', (_event, win) => {
  if (config.get('options.overrideUserAgent')) {
    // User agents are from https://developers.whatismybrowser.com/useragents/explore/
    const originalUserAgent = win.webContents.userAgent;
    const userAgents = {
      mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.152 Safari/537.36',
      windows:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.152 Safari/537.36',
      linux:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.152 Safari/537.36',
    };

    const updatedUserAgent = is.macOS()
      ? userAgents.mac
      : is.windows()
        ? userAgents.windows
        : userAgents.linux;

    win.webContents.userAgent = updatedUserAgent;
    app.userAgentFallback = updatedUserAgent;

    win.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
      // This will only happen if login failed, and "retry" was pressed
      if (
        win.webContents.getURL().startsWith('https://accounts.google.com') &&
        details.url.startsWith('https://accounts.google.com')
      ) {
        details.requestHeaders['User-Agent'] = originalUserAgent;
      }

      cb({ requestHeaders: details.requestHeaders });
    });
  }

  setupSongInfo(win);
  setupAppControls();

  win.webContents.on(
    'did-fail-load',
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      const log = JSON.stringify(
        {
          error: 'did-fail-load',
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
          frameProcessId,
          frameRoutingId,
        },
        null,
        '\t',
      );
      if (is.dev()) {
        console.log(log);
      }

      // A frame inside the page that fails to load, such as an ad, must not
      // replace the page. -3 is an aborted load, not a failed one.
      if (isMainFrame && errorCode !== -3) {
        win.webContents.send('log', log);
        win.webContents.loadFile(ErrorHtmlAsset);
      }
    },
  );

  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  const customWindowTitle = config.get('options.customWindowTitle');
  const windowTitle = (pageTitle: string) =>
    guestOf
      ? guestTitle(
          t('main.window.guest-title', { applicationName: APPLICATION_NAME }),
          // The page's title is often the app's name, which the label holds.
          customWindowTitle ||
            (pageTitle === APPLICATION_NAME ? '' : pageTitle),
        )
      : (customWindowTitle ?? pageTitle);

  if (guestOf) win.setTitle(windowTitle(''));
  if (customWindowTitle || guestOf) {
    win.on('page-title-updated', (event, pageTitle) => {
      event.preventDefault();
      win.setTitle(windowTitle(pageTitle));
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }

  // Unregister all shortcuts.
  globalShortcut.unregisterAll();
});

app.on('activate', async () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    mainWindow = await createMainWindow();
  } else if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
});

const getDefaultLocale = async (locale: string) =>
  Object.keys(await languageResources()).includes(locale) ? locale : null;

app.whenReady().then(async () => {
  // The version number stays at the upstream release, so the About panel also
  // names the commit and date of the build. The build replaces both values.
  // Only macOS shows `version`, next to the release.
  const build = [process.env.BUILD_COMMIT, process.env.BUILD_DATE]
    .filter(Boolean)
    .join(', ');
  app.setAboutPanelOptions(
    is.macOS()
      ? { version: build }
      : { applicationVersion: `${app.getVersion()} (${build})` },
  );

  if (!config.get('options.language')) {
    const locale = await getDefaultLocale(app.getLocale());
    if (locale) {
      config.set('options.language', locale);
    }
  }

  await loadI18n().then(async () => {
    await setLanguage(config.get('options.language') ?? 'en');
    console.log(LoggerPrefix, t('main.console.i18n.loaded'));
  });

  if (config.get('options.autoResetAppCache')) {
    // Clear cache after 20s
    const clearCacheTimeout = setTimeout(() => {
      if (is.dev()) {
        console.log(
          LoggerPrefix,
          t('main.console.when-ready.clearing-cache-after-20s'),
        );
      }

      session.defaultSession.clearCache();
      clearTimeout(clearCacheTimeout);
    }, 20_000);
  }

  // Register appID on windows
  if (is.windows()) {
    const appID = 'io.github.hawkff.rien';
    app.setAppUserModelId(appID);
    const appLocation = process.execPath;
    const appData = app.getPath('appData');
    // Check shortcut validity if not in dev mode / running portable app
    if (
      !is.dev() &&
      !appLocation.startsWith(path.join(appData, '..', 'Local', 'Temp'))
    ) {
      const shortcutPath = path.join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        `${APPLICATION_NAME}.lnk`,
      );
      try {
        // Check if shortcut is registered and valid
        const shortcutDetails = shell.readShortcutLink(shortcutPath); // Throw error if it doesn't exist yet
        if (
          shortcutDetails.target !== appLocation ||
          shortcutDetails.appUserModelId !== appID
        ) {
          // oxlint-disable-next-line typescript/only-throw-error
          throw 'needUpdate';
        }
      } catch (error) {
        // If not valid -> Register shortcut
        shell.writeShortcutLink(
          shortcutPath,
          error === 'needUpdate' ? 'update' : 'create',
          {
            target: appLocation,
            cwd: path.dirname(appLocation),
            description: `${APPLICATION_NAME} Desktop App - including custom plugins`,
            appUserModelId: appID,
          },
        );
      }
    }
  }

  ipcMain.on('get-renderer-scripts', (event, plugins: string[]) => {
    // In dev mode, the page loads the renderer from the vite dev server
    if (is.dev() && process.env.ELECTRON_RENDERER_URL) {
      // HACK: to make vite work with electron renderer (supports hot reload)
      event.returnValue = {
        dev: `
        console.log('${LoggerPrefix}', 'Loading vite from dev server');
        (async () => {
          await new Promise((resolve) => {
            if (document.readyState === 'loading') {
              console.log('${LoggerPrefix}', 'Waiting for DOM to load');
              document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
            } else {
              resolve();
            }
          });
          const viteScript = document.createElement('script');
          viteScript.type = 'module';
          viteScript.src = '${process.env.ELECTRON_RENDERER_URL}/@vite/client';
          const rendererScript = document.createElement('script');
          rendererScript.type = 'module';
          rendererScript.src = '${process.env.ELECTRON_RENDERER_URL}/renderer.ts';
          document.body.appendChild(viteScript);
          document.body.appendChild(rendererScript);
        })();
        0
      `,
      };
    } else {
      event.returnValue = getRendererScripts(plugins);
    }
  });
  ipcMain.on(
    'get-renderer-plugin-scripts',
    (event, id: string, loaded: string[]) => {
      event.returnValue = getRendererPluginScripts(id, loaded);
    },
  );

  mainWindow = await createMainWindow();
  await setApplicationMenu(mainWindow);
  await refreshMenu(mainWindow);
  setUpTray(app, mainWindow);

  setupProtocolHandler(mainWindow);

  app.on('second-instance', (_, commandLine) => {
    const uri = `${APP_PROTOCOL}://`;
    const protocolArgv = commandLine.find((arg) => arg.startsWith(uri));
    if (protocolArgv) {
      const lastIndex = protocolArgv.endsWith('/') ? -1 : undefined;
      const command = protocolArgv.slice(uri.length, lastIndex);
      if (is.dev()) {
        console.debug(
          LoggerPrefix,
          t('main.console.second-instance.receive-command', { command }),
        );
      }

      const splited = decodeURIComponent(command).split(' ');

      handleProtocol(splited.shift()!, ...splited);
      return;
    }

    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }

    mainWindow.focus();
  });

  // Autostart at login
  app.setLoginItemSettings({
    openAtLogin: config.get('options.startAtLogin'),
  });

  if (config.get('options.hideMenu') && !config.get('options.hideMenuWarned')) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: t('main.dialog.hide-menu-enabled.title'),
      message: t('main.dialog.hide-menu-enabled.message'),
    });
    config.set('options.hideMenuWarned', true);
  }

  // Optimized for Mac OS X
  if (is.macOS() && !config.get('options.appVisible')) {
    app.dock?.hide();
  }

  let forceQuit = false;
  app.on('before-quit', () => {
    forceQuit = true;
  });

  if (is.macOS() || config.get('options.tray')) {
    mainWindow.on('close', (event) => {
      // Hide the window instead of quitting (quit is available in tray options)
      if (!forceQuit) {
        event.preventDefault();
        mainWindow!.hide();
      }
    });
  }
});

function showUnresponsiveDialog(
  win: BrowserWindow,
  details: Electron.RenderProcessGoneDetails,
) {
  if (details) {
    console.error(
      LoggerPrefix,
      t('main.console.unresponsive.details', {
        error: JSON.stringify(details, null, '\t'),
      }),
    );
  }

  dialog
    .showMessageBox(win, {
      type: 'error',
      title: t('main.dialog.unresponsive.title'),
      message: t('main.dialog.unresponsive.message'),
      detail: t('main.dialog.unresponsive.detail'),
      buttons: [
        t('main.dialog.unresponsive.buttons.wait'),
        t('main.dialog.unresponsive.buttons.relaunch'),
        t('main.dialog.unresponsive.buttons.quit'),
      ],
      cancelId: 0,
    })
    .then((result) => {
      switch (result.response) {
        case 1: {
          restart();
          break;
        }

        case 2: {
          app.quit();
          break;
        }
      }
    });
}

function removeContentSecurityPolicy(
  betterSession: BetterSession = session.defaultSession as BetterSession,
) {
  // Allows defining multiple "onHeadersReceived" listeners
  // by enhancing the session.
  // Some plugins (e.g. adblocker) also define a "onHeadersReceived" listener
  enhanceWebRequest(betterSession);

  // Custom listener to tweak the content security policy
  betterSession.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders ??= {};

    // prettier-ignore
    if (URL.parse(details.url)?.protocol === 'https:') {
      // Remove the content security policy
      delete details.responseHeaders['content-security-policy-report-only'];
      delete details.responseHeaders['Content-Security-Policy-Report-Only'];
      delete details.responseHeaders['content-security-policy'];
      delete details.responseHeaders['Content-Security-Policy'];

      if (
        !details.responseHeaders['access-control-allow-origin'] &&
        !details.responseHeaders['Access-Control-Allow-Origin']
      ) {
        details.responseHeaders['access-control-allow-origin'] = ['https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com'];
      }
    }

    callback({ cancel: false, responseHeaders: details.responseHeaders });
  });

  // When multiple listeners are defined, apply them all
  betterSession.webRequest.setResolver(
    'onHeadersReceived',
    async (listeners) => {
      return listeners.reduce(
        async (accumulator, listener) => {
          const acc = await accumulator;
          if (acc.cancel) {
            return acc;
          }

          const result = await listener.apply();
          return { ...acc, ...result };
        },
        Promise.resolve({ cancel: false }),
      );
    },
  );
}
