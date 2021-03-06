const crypto = require('crypto')
const path = require('path')
const {ipcRenderer} = require('electron')

const _ = require('underscore-plus')
const {deprecate} = require('grim')
const {CompositeDisposable, Disposable, Emitter} = require('event-kit')
const fs = require('fs-plus')
const {mapSourcePosition} = require('@atom/source-map-support')
const WindowEventHandler = require('./window-event-handler')
const StateStore = require('./state-store')
const StorageFolder = require('./storage-folder')
const registerDefaultCommands = require('./register-default-commands')
const {updateProcessEnv} = require('./update-process-env')
const ConfigSchema = require('./config-schema')

const DeserializerManager = require('./deserializer-manager')
const ViewRegistry = require('./view-registry')
const NotificationManager = require('./notification-manager')
const Config = require('./config')
const KeymapManager = require('./keymap-extensions')
const TooltipManager = require('./tooltip-manager')
const CommandRegistry = require('./command-registry')
const URIHandlerRegistry = require('./uri-handler-registry')
const GrammarRegistry = require('./grammar-registry')
const {HistoryManager} = require('./history-manager')
const ReopenProjectMenuManager = require('./reopen-project-menu-manager')
const StyleManager = require('./style-manager')
const PackageManager = require('./package-manager')
const ThemeManager = require('./theme-manager')
const MenuManager = require('./menu-manager')
const ContextMenuManager = require('./context-menu-manager')
const CommandInstaller = require('./command-installer')
const CoreURIHandlers = require('./core-uri-handlers')
const ProtocolHandlerInstaller = require('./protocol-handler-installer')
const Project = require('./project')
const TitleBar = require('./title-bar')
const Workspace = require('./workspace')
const PaneContainer = require('./pane-container')
const PaneAxis = require('./pane-axis')
const Pane = require('./pane')
const Dock = require('./dock')
const TextEditor = require('./text-editor')
const TextBuffer = require('text-buffer')
const TextEditorRegistry = require('./text-editor-registry')
const AutoUpdateManager = require('./auto-update-manager')

let nextId = 0

// Essential: Atom global for dealing with packages, themes, menus, and the window.
//
// An instance of this class is always available as the `atom` global.
class AtomEnvironment {
  /*
  Section: Construction and Destruction
  */

  // Call .loadOrCreate instead
  constructor (params = {}) {
    this.id = (params.id != null) ? params.id : nextId++
    this.clipboard = params.clipboard
    this.updateProcessEnv = params.updateProcessEnv || updateProcessEnv
    this.enablePersistence = params.enablePersistence
    this.applicationDelegate = params.applicationDelegate

    this.nextProxyRequestId = 0
    this.unloaded = false
    this.loadTime = null
    this.emitter = new Emitter()
    this.disposables = new CompositeDisposable()
    this.deserializers = new DeserializerManager(this)
    this.deserializeTimings = {}
    this.views = new ViewRegistry(this)
    this.notifications = new NotificationManager()

    this.stateStore = new StateStore('AtomEnvironments', 1)

    this.config = new Config({
      notificationManager: this.notifications,
      enablePersistence: this.enablePersistence
    })
    this.config.setSchema(null, {type: 'object', properties: _.clone(ConfigSchema)})

    this.keymaps = new KeymapManager({notificationManager: this.notifications})
    this.tooltips = new TooltipManager({keymapManager: this.keymaps, viewRegistry: this.views})
    this.commands = new CommandRegistry()
    this.uriHandlerRegistry = new URIHandlerRegistry()
    this.grammars = new GrammarRegistry({config: this.config})
    this.styles = new StyleManager()
    this.packages = new PackageManager({
      config: this.config,
      styleManager: this.styles,
      commandRegistry: this.commands,
      keymapManager: this.keymaps,
      notificationManager: this.notifications,
      grammarRegistry: this.grammars,
      deserializerManager: this.deserializers,
      viewRegistry: this.views,
      uriHandlerRegistry: this.uriHandlerRegistry
    })
    this.themes = new ThemeManager({
      packageManager: this.packages,
      config: this.config,
      styleManager: this.styles,
      notificationManager: this.notifications,
      viewRegistry: this.views
    })
    this.menu = new MenuManager({keymapManager: this.keymaps, packageManager: this.packages})
    this.contextMenu = new ContextMenuManager({keymapManager: this.keymaps})
    this.packages.setMenuManager(this.menu)
    this.packages.setContextMenuManager(this.contextMenu)
    this.packages.setThemeManager(this.themes)

    this.project = new Project({
      notificationManager: this.notifications,
      packageManager: this.packages,
      grammarRegistry: this.grammars,
      config: this.config,
      applicationDelegate: this.applicationDelegate
    })
    this.commandInstaller = new CommandInstaller(this.applicationDelegate)
    this.protocolHandlerInstaller = new ProtocolHandlerInstaller()

    this.textEditors = new TextEditorRegistry({
      config: this.config,
      grammarRegistry: this.grammars,
      assert: this.assert.bind(this),
      packageManager: this.packages
    })

    this.workspace = new Workspace({
      config: this.config,
      project: this.project,
      packageManager: this.packages,
      grammarRegistry: this.grammars,
      deserializerManager: this.deserializers,
      notificationManager: this.notifications,
      applicationDelegate: this.applicationDelegate,
      viewRegistry: this.views,
      assert: this.assert.bind(this),
      textEditorRegistry: this.textEditors,
      styleManager: this.styles,
      enablePersistence: this.enablePersistence
    })

    this.themes.workspace = this.workspace

    this.autoUpdater = new AutoUpdateManager({applicationDelegate: this.applicationDelegate})

    if (this.keymaps.canLoadBundledKeymapsFromMemory()) {
      this.keymaps.loadBundledKeymaps()
    }

    this.registerDefaultCommands()
    this.registerDefaultOpeners()
    this.registerDefaultDeserializers()

    this.windowEventHandler = new WindowEventHandler({atomEnvironment: this, applicationDelegate: this.applicationDelegate})

    this.history = new HistoryManager({project: this.project, commands: this.commands, stateStore: this.stateStore})
    // Keep instances of HistoryManager in sync
    this.disposables.add(this.history.onDidChangeProjects(event => {
      if (!event.reloaded) this.applicationDelegate.didChangeHistoryManager()
    }))
  }

  initialize (params = {}) {
    // This will force TextEditorElement to register the custom element, so that
    // using `document.createElement('atom-text-editor')` works if it's called
    // before opening a buffer.
    require('./text-editor-element')

    this.window = params.window
    this.document = params.document
    this.blobStore = params.blobStore
    this.configDirPath = params.configDirPath

    const {devMode, safeMode, resourcePath, clearWindowState} = this.getLoadSettings()

    if (clearWindowState) {
      this.getStorageFolder().clear()
      this.stateStore.clear()
    }

    ConfigSchema.projectHome = {
      type: 'string',
      default: path.join(fs.getHomeDirectory(), 'github'),
      description: 'The directory where projects are assumed to be located. Packages created using the Package Generator will be stored here by default.'
    }
    this.config.initialize({configDirPath: this.configDirPath, resourcePath, projectHomeSchema: ConfigSchema.projectHome})

    this.menu.initialize({resourcePath})
    this.contextMenu.initialize({resourcePath, devMode})

    this.keymaps.configDirPath = this.configDirPath
    this.keymaps.resourcePath = resourcePath
    this.keymaps.devMode = devMode
    if (!this.keymaps.canLoadBundledKeymapsFromMemory()) {
      this.keymaps.loadBundledKeymaps()
    }

    this.commands.attach(this.window)

    this.styles.initialize({configDirPath: this.configDirPath})
    this.packages.initialize({devMode, configDirPath: this.configDirPath, resourcePath, safeMode})
    this.themes.initialize({configDirPath: this.configDirPath, resourcePath, safeMode, devMode})

    this.commandInstaller.initialize(this.getVersion())
    this.uriHandlerRegistry.registerHostHandler('core', CoreURIHandlers.create(this))
    this.autoUpdater.initialize()

    this.config.load()

    this.protocolHandlerInstaller.initialize(this.config, this.notifications)

    this.themes.loadBaseStylesheets()
    this.initialStyleElements = this.styles.getSnapshot()
    if (params.onlyLoadBaseStyleSheets) this.themes.initialLoadComplete = true
    this.setBodyPlatformClass()

    this.stylesElement = this.styles.buildStylesElement()
    this.document.head.appendChild(this.stylesElement)

    this.keymaps.subscribeToFileReadFailure()

    this.installUncaughtErrorHandler()
    this.attachSaveStateListeners()
    this.windowEventHandler.initialize(this.window, this.document)

    const didChangeStyles = this.didChangeStyles.bind(this)
    this.disposables.add(this.styles.onDidAddStyleElement(didChangeStyles))
    this.disposables.add(this.styles.onDidUpdateStyleElement(didChangeStyles))
    this.disposables.add(this.styles.onDidRemoveStyleElement(didChangeStyles))

    this.observeAutoHideMenuBar()

    this.disposables.add(this.applicationDelegate.onDidChangeHistoryManager(() => this.history.loadState()))
  }

  preloadPackages () {
    return this.packages.preloadPackages()
  }

  attachSaveStateListeners () {
    const saveState = _.debounce(() => {
      this.window.requestIdleCallback(() => {
        if (!this.unloaded) this.saveState({isUnloading: false})
      })
    }, this.saveStateDebounceInterval)
    this.document.addEventListener('mousedown', saveState, true)
    this.document.addEventListener('keydown', saveState, true)
    this.disposables.add(new Disposable(() => {
      this.document.removeEventListener('mousedown', saveState, true)
      this.document.removeEventListener('keydown', saveState, true)
    }))
  }

  registerDefaultDeserializers () {
    this.deserializers.add(Workspace)
    this.deserializers.add(PaneContainer)
    this.deserializers.add(PaneAxis)
    this.deserializers.add(Pane)
    this.deserializers.add(Dock)
    this.deserializers.add(Project)
    this.deserializers.add(TextEditor)
    this.deserializers.add(TextBuffer)
  }

  registerDefaultCommands () {
    registerDefaultCommands({commandRegistry: this.commands, config: this.config, commandInstaller: this.commandInstaller, notificationManager: this.notifications, project: this.project, clipboard: this.clipboard})
  }

  registerDefaultOpeners () {
    this.workspace.addOpener(uri => {
      switch (uri) {
        case 'atom://.atom/stylesheet':
          return this.workspace.openTextFile(this.styles.getUserStyleSheetPath())
        case 'atom://.atom/keymap':
          return this.workspace.openTextFile(this.keymaps.getUserKeymapPath())
        case 'atom://.atom/config':
          return this.workspace.openTextFile(this.config.getUserConfigPath())
        case 'atom://.atom/init-script':
          return this.workspace.openTextFile(this.getUserInitScriptPath())
      }
    })
  }

  registerDefaultTargetForKeymaps () {
    this.keymaps.defaultTarget = this.workspace.getElement()
  }

  observeAutoHideMenuBar () {
    this.disposables.add(this.config.onDidChange('core.autoHideMenuBar', ({newValue}) => {
      this.setAutoHideMenuBar(newValue)
    }))
    if (this.config.get('core.autoHideMenuBar')) this.setAutoHideMenuBar(true)
  }

  async reset () {
    this.deserializers.clear()
    this.registerDefaultDeserializers()

    this.config.clear()
    this.config.setSchema(null, {type: 'object', properties: _.clone(ConfigSchema)})

    this.keymaps.clear()
    this.keymaps.loadBundledKeymaps()

    this.commands.clear()
    this.registerDefaultCommands()

    this.styles.restoreSnapshot(this.initialStyleElements)

    this.menu.clear()

    this.clipboard.reset()

    this.notifications.clear()

    this.contextMenu.clear()

    await this.packages.reset()
    this.workspace.reset(this.packages)
    this.registerDefaultOpeners()
    this.project.reset(this.packages)
    this.workspace.subscribeToEvents()
    this.grammars.clear()
    this.textEditors.clear()
    this.views.clear()
  }

  destroy () {
    if (!this.project) return

    this.disposables.dispose()
    if (this.workspace) this.workspace.destroy()
    this.workspace = null
    this.themes.workspace = null
    if (this.project) this.project.destroy()
    this.project = null
    this.commands.clear()
    this.stylesElement.remove()
    this.config.unobserveUserConfig()
    this.autoUpdater.destroy()
    this.uriHandlerRegistry.destroy()

    this.uninstallWindowEventHandler()
  }

  /*
  Section: Event Subscription
  */

  // Extended: Invoke the given callback whenever {::beep} is called.
  //
  // * `callback` {Function} to be called whenever {::beep} is called.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidBeep (callback) {
    return this.emitter.on('did-beep', callback)
  }

  // Extended: Invoke the given callback when there is an unhandled error, but
  // before the devtools pop open
  //
  // * `callback` {Function} to be called whenever there is an unhandled error
  //   * `event` {Object}
  //     * `originalError` {Object} the original error object
  //     * `message` {String} the original error object
  //     * `url` {String} Url to the file where the error originated.
  //     * `line` {Number}
  //     * `column` {Number}
  //     * `preventDefault` {Function} call this to avoid popping up the dev tools.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onWillThrowError (callback) {
    return this.emitter.on('will-throw-error', callback)
  }

  // Extended: Invoke the given callback whenever there is an unhandled error.
  //
  // * `callback` {Function} to be called whenever there is an unhandled error
  //   * `event` {Object}
  //     * `originalError` {Object} the original error object
  //     * `message` {String} the original error object
  //     * `url` {String} Url to the file where the error originated.
  //     * `line` {Number}
  //     * `column` {Number}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidThrowError (callback) {
    return this.emitter.on('did-throw-error', callback)
  }

  // TODO: Make this part of the public API. We should make onDidThrowError
  // match the interface by only yielding an exception object to the handler
  // and deprecating the old behavior.
  onDidFailAssertion (callback) {
    return this.emitter.on('did-fail-assertion', callback)
  }

  // Extended: Invoke the given callback as soon as the shell environment is
  // loaded (or immediately if it was already loaded).
  //
  // * `callback` {Function} to be called whenever there is an unhandled error
  whenShellEnvironmentLoaded (callback) {
    if (this.shellEnvironmentLoaded) {
      callback()
      return new Disposable()
    } else {
      return this.emitter.once('loaded-shell-environment', callback)
    }
  }

  /*
  Section: Atom Details
  */

  // Public: Returns a {Boolean} that is `true` if the current window is in development mode.
  inDevMode () {
    if (this.devMode == null) this.devMode = this.getLoadSettings().devMode
    return this.devMode
  }

  // Public: Returns a {Boolean} that is `true` if the current window is in safe mode.
  inSafeMode () {
    if (this.safeMode == null) this.safeMode = this.getLoadSettings().safeMode
    return this.safeMode
  }

  // Public: Returns a {Boolean} that is `true` if the current window is running specs.
  inSpecMode () {
    if (this.specMode == null) this.specMode = this.getLoadSettings().isSpec
    return this.specMode
  }

  // Returns a {Boolean} indicating whether this the first time the window's been
  // loaded.
  isFirstLoad () {
    if (this.firstLoad == null) this.firstLoad = this.getLoadSettings().firstLoad
    return this.firstLoad
  }

  // Public: Get the version of the Atom application.
  //
  // Returns the version text {String}.
  getVersion () {
    if (this.appVersion == null) this.appVersion = this.getLoadSettings().appVersion
    return this.appVersion
  }

  // Public: Gets the release channel of the Atom application.
  //
  // Returns the release channel as a {String}. Will return one of `dev`, `beta`, or `stable`.
  getReleaseChannel () {
    const version = this.getVersion()
    if (version.includes('beta')) {
      return 'beta'
    } else if (version.includes('dev')) {
      return 'dev'
    } else {
      return 'stable'
    }
  }

  // Public: Returns a {Boolean} that is `true` if the current version is an official release.
  isReleasedVersion () {
    return !/\w{7}/.test(this.getVersion()) // Check if the release is a 7-character SHA prefix
  }

  // Public: Get the time taken to completely load the current window.
  //
  // This time include things like loading and activating packages, creating
  // DOM elements for the editor, and reading the config.
  //
  // Returns the {Number} of milliseconds taken to load the window or null
  // if the window hasn't finished loading yet.
  getWindowLoadTime () {
    return this.loadTime
  }

  // Public: Get the load settings for the current window.
  //
  // Returns an {Object} containing all the load setting key/value pairs.
  getLoadSettings () {
    return this.applicationDelegate.getWindowLoadSettings()
  }

  /*
  Section: Managing The Atom Window
  */

  // Essential: Open a new Atom window using the given options.
  //
  // Calling this method without an options parameter will open a prompt to pick
  // a file/folder to open in the new window.
  //
  // * `params` An {Object} with the following keys:
  //   * `pathsToOpen`  An {Array} of {String} paths to open.
  //   * `newWindow` A {Boolean}, true to always open a new window instead of
  //     reusing existing windows depending on the paths to open.
  //   * `devMode` A {Boolean}, true to open the window in development mode.
  //     Development mode loads the Atom source from the locally cloned
  //     repository and also loads all the packages in ~/.atom/dev/packages
  //   * `safeMode` A {Boolean}, true to open the window in safe mode. Safe
  //     mode prevents all packages installed to ~/.atom/packages from loading.
  open (params) {
    return this.applicationDelegate.open(params)
  }

  // Extended: Prompt the user to select one or more folders.
  //
  // * `callback` A {Function} to call once the user has confirmed the selection.
  //   * `paths` An {Array} of {String} paths that the user selected, or `null`
  //     if the user dismissed the dialog.
  pickFolder (callback) {
    return this.applicationDelegate.pickFolder(callback)
  }

  // Essential: Close the current window.
  close () {
    return this.applicationDelegate.closeWindow()
  }

  // Essential: Get the size of current window.
  //
  // Returns an {Object} in the format `{width: 1000, height: 700}`
  getSize () {
    return this.applicationDelegate.getWindowSize()
  }

  // Essential: Set the size of current window.
  //
  // * `width` The {Number} of pixels.
  // * `height` The {Number} of pixels.
  setSize (width, height) {
    return this.applicationDelegate.setWindowSize(width, height)
  }

  // Essential: Get the position of current window.
  //
  // Returns an {Object} in the format `{x: 10, y: 20}`
  getPosition () {
    return this.applicationDelegate.getWindowPosition()
  }

  // Essential: Set the position of current window.
  //
  // * `x` The {Number} of pixels.
  // * `y` The {Number} of pixels.
  setPosition (x, y) {
    return this.applicationDelegate.setWindowPosition(x, y)
  }

  // Extended: Get the current window
  getCurrentWindow () {
    return this.applicationDelegate.getCurrentWindow()
  }

  // Extended: Move current window to the center of the screen.
  center () {
    return this.applicationDelegate.centerWindow()
  }

  // Extended: Focus the current window.
  focus () {
    this.applicationDelegate.focusWindow()
    return this.window.focus()
  }

  // Extended: Show the current window.
  show () {
    return this.applicationDelegate.showWindow()
  }

  // Extended: Hide the current window.
  hide () {
    return this.applicationDelegate.hideWindow()
  }

  // Extended: Reload the current window.
  reload () {
    return this.applicationDelegate.reloadWindow()
  }

  // Extended: Relaunch the entire application.
  restartApplication () {
    return this.applicationDelegate.restartApplication()
  }

  // Extended: Returns a {Boolean} that is `true` if the current window is maximized.
  isMaximized () {
    return this.applicationDelegate.isWindowMaximized()
  }

  maximize () {
    return this.applicationDelegate.maximizeWindow()
  }

  // Extended: Returns a {Boolean} that is `true` if the current window is in full screen mode.
  isFullScreen () {
    return this.applicationDelegate.isWindowFullScreen()
  }

  // Extended: Set the full screen state of the current window.
  setFullScreen (fullScreen = false) {
    return this.applicationDelegate.setWindowFullScreen(fullScreen)
  }

  // Extended: Toggle the full screen state of the current window.
  toggleFullScreen () {
    return this.setFullScreen(!this.isFullScreen())
  }

  // Restore the window to its previous dimensions and show it.
  //
  // Restores the full screen and maximized state after the window has resized to
  // prevent resize glitches.
  async displayWindow () {
    await this.restoreWindowDimensions()
    const steps = [
      this.restoreWindowBackground(),
      this.show(),
      this.focus()
    ]
    if (this.windowDimensions && this.windowDimensions.fullScreen) {
      steps.push(this.setFullScreen(true))
    }
    if (this.windowDimensions && this.windowDimensions.maximized && process.platform !== 'darwin') {
      steps.push(this.maximize())
    }
    await Promise.all(steps)
  }

  // Get the dimensions of this window.
  //
  // Returns an {Object} with the following keys:
  //   * `x`      The window's x-position {Number}.
  //   * `y`      The window's y-position {Number}.
  //   * `width`  The window's width {Number}.
  //   * `height` The window's height {Number}.
  getWindowDimensions () {
    const browserWindow = this.getCurrentWindow()
    const [x, y] = browserWindow.getPosition()
    const [width, height] = browserWindow.getSize()
    const maximized = browserWindow.isMaximized()
    return {x, y, width, height, maximized}
  }

  // Set the dimensions of the window.
  //
  // The window will be centered if either the x or y coordinate is not set
  // in the dimensions parameter. If x or y are omitted the window will be
  // centered. If height or width are omitted only the position will be changed.
  //
  // * `dimensions` An {Object} with the following keys:
  //   * `x` The new x coordinate.
  //   * `y` The new y coordinate.
  //   * `width` The new width.
  //   * `height` The new height.
  setWindowDimensions ({x, y, width, height}) {
    const steps = []
    if (width != null && height != null) {
      steps.push(this.setSize(width, height))
    }
    if (x != null && y != null) {
      steps.push(this.setPosition(x, y))
    } else {
      steps.push(this.center())
    }
    return Promise.all(steps)
  }

  // Returns true if the dimensions are useable, false if they should be ignored.
  // Work around for https://github.com/atom/atom-shell/issues/473
  isValidDimensions ({x, y, width, height} = {}) {
    return (width > 0) && (height > 0) && ((x + width) > 0) && ((y + height) > 0)
  }

  storeWindowDimensions () {
    this.windowDimensions = this.getWindowDimensions()
    if (this.isValidDimensions(this.windowDimensions)) {
      localStorage.setItem('defaultWindowDimensions', JSON.stringify(this.windowDimensions))
    }
  }

  getDefaultWindowDimensions () {
    const {windowDimensions} = this.getLoadSettings()
    if (windowDimensions) return windowDimensions

    let dimensions
    try {
      dimensions = JSON.parse(localStorage.getItem('defaultWindowDimensions'))
    } catch (error) {
      console.warn('Error parsing default window dimensions', error)
      localStorage.removeItem('defaultWindowDimensions')
    }

    if (dimensions && this.isValidDimensions(dimensions)) {
      return dimensions
    } else {
      const {width, height} = this.applicationDelegate.getPrimaryDisplayWorkAreaSize()
      return {x: 0, y: 0, width: Math.min(1024, width), height}
    }
  }

  async restoreWindowDimensions () {
    if (!this.windowDimensions || !this.isValidDimensions(this.windowDimensions)) {
      this.windowDimensions = this.getDefaultWindowDimensions()
    }
    await this.setWindowDimensions(this.windowDimensions)
    return this.windowDimensions
  }

  restoreWindowBackground () {
    const backgroundColor = window.localStorage.getItem('atom:window-background-color')
    if (backgroundColor) {
      this.backgroundStylesheet = document.createElement('style')
      this.backgroundStylesheet.type = 'text/css'
      this.backgroundStylesheet.innerText = `html, body { background: ${backgroundColor} !important; }`
      document.head.appendChild(this.backgroundStylesheet)
    }
  }

  storeWindowBackground () {
    if (this.inSpecMode()) return

    const backgroundColor = this.window.getComputedStyle(this.workspace.getElement())['background-color']
    this.window.localStorage.setItem('atom:window-background-color', backgroundColor)
  }

  // Call this method when establishing a real application window.
  startEditorWindow () {
    this.unloaded = false

    const updateProcessEnvPromise = this.updateProcessEnvAndTriggerHooks()

    const loadStatePromise = this.loadState().then(async state => {
      this.windowDimensions = state && state.windowDimensions
      await this.displayWindow()
      this.commandInstaller.installAtomCommand(false, (error) => {
        if (error) console.warn(error.message)
      })
      this.commandInstaller.installApmCommand(false, (error) => {
        if (error) console.warn(error.message)
      })

      this.disposables.add(this.applicationDelegate.onDidOpenLocations(this.openLocations.bind(this)))
      this.disposables.add(this.applicationDelegate.onApplicationMenuCommand(this.dispatchApplicationMenuCommand.bind(this)))
      this.disposables.add(this.applicationDelegate.onContextMenuCommand(this.dispatchContextMenuCommand.bind(this)))
      this.disposables.add(this.applicationDelegate.onURIMessage(this.dispatchURIMessage.bind(this)))
      this.disposables.add(this.applicationDelegate.onDidRequestUnload(async () => {
        try {
          await this.saveState({isUnloading: true})
        } catch (error) {
          console.error(error)
        }

        const closing = !this.workspace || await this.workspace.confirmClose({
          windowCloseRequested: true,
          projectHasPaths: this.project.getPaths().length > 0
        })

        if (closing) await this.packages.deactivatePackages()
        return closing
      }))

      this.listenForUpdates()

      this.registerDefaultTargetForKeymaps()

      this.packages.loadPackages()

      const startTime = Date.now()
      await this.deserialize(state)
      this.deserializeTimings.atom = Date.now() - startTime

      if (process.platform === 'darwin' && this.config.get('core.titleBar') === 'custom') {
        this.workspace.addHeaderPanel({item: new TitleBar({workspace: this.workspace, themes: this.themes, applicationDelegate: this.applicationDelegate})})
        this.document.body.classList.add('custom-title-bar')
      }
      if (process.platform === 'darwin' && this.config.get('core.titleBar') === 'custom-inset') {
        this.workspace.addHeaderPanel({item: new TitleBar({workspace: this.workspace, themes: this.themes, applicationDelegate: this.applicationDelegate})})
        this.document.body.classList.add('custom-inset-title-bar')
      }
      if (process.platform === 'darwin' && this.config.get('core.titleBar') === 'hidden') {
        this.document.body.classList.add('hidden-title-bar')
      }

      this.document.body.appendChild(this.workspace.getElement())
      if (this.backgroundStylesheet) this.backgroundStylesheet.remove()

      this.watchProjectPaths()

      this.packages.activate()
      this.keymaps.loadUserKeymap()
      if (!this.getLoadSettings().safeMode) this.requireUserInitScript()

      this.menu.update()

      await this.openInitialEmptyEditorIfNecessary()
    })

    const loadHistoryPromise = this.history.loadState().then(() => {
      this.reopenProjectMenuManager = new ReopenProjectMenuManager({
        menu: this.menu,
        commands: this.commands,
        history: this.history,
        config: this.config,
        open: paths => this.open({pathsToOpen: paths})
      })
      this.reopenProjectMenuManager.update()
    })

    return Promise.all([loadStatePromise, loadHistoryPromise, updateProcessEnvPromise])
  }

  serialize (options) {
    return {
      version: this.constructor.version,
      project: this.project.serialize(options),
      workspace: this.workspace.serialize(),
      packageStates: this.packages.serialize(),
      grammars: this.grammars.serialize(),
      fullScreen: this.isFullScreen(),
      windowDimensions: this.windowDimensions
    }
  }

  unloadEditorWindow () {
    if (!this.project) return

    this.storeWindowBackground()
    this.saveBlobStoreSync()
    this.unloaded = true
  }

  saveBlobStoreSync () {
    if (this.enablePersistence) {
      this.blobStore.save()
    }
  }

  openInitialEmptyEditorIfNecessary () {
    if (!this.config.get('core.openEmptyEditorOnStart')) return
    const {initialPaths} = this.getLoadSettings()
    if (initialPaths && initialPaths.length === 0 && this.workspace.getPaneItems().length === 0) {
      return this.workspace.open(null)
    }
  }

  installUncaughtErrorHandler () {
    this.previousWindowErrorHandler = this.window.onerror
    this.window.onerror = (message, url, line, column, originalError) => {
      const mapping = mapSourcePosition({source: url, line, column})
      line = mapping.line
      column = mapping.column
      if (url === '<embedded>') url = mapping.source

      const eventObject = {message, url, line, column, originalError}

      let openDevTools = true
      eventObject.preventDefault = () => { openDevTools = false }

      this.emitter.emit('will-throw-error', eventObject)

      if (openDevTools) {
        this.openDevTools().then(() =>
          this.executeJavaScriptInDevTools('DevToolsAPI.showPanel("console")')
        )
      }

      this.emitter.emit('did-throw-error', {message, url, line, column, originalError})
    }
  }

  uninstallUncaughtErrorHandler () {
    this.window.onerror = this.previousWindowErrorHandler
  }

  installWindowEventHandler () {
    this.windowEventHandler = new WindowEventHandler({atomEnvironment: this, applicationDelegate: this.applicationDelegate})
    this.windowEventHandler.initialize(this.window, this.document)
  }

  uninstallWindowEventHandler () {
    if (this.windowEventHandler) {
      this.windowEventHandler.unsubscribe()
    }
    this.windowEventHandler = null
  }

  didChangeStyles (styleElement) {
    TextEditor.didUpdateStyles()
    if (styleElement.textContent.indexOf('scrollbar') >= 0) {
      TextEditor.didUpdateScrollbarStyles()
    }
  }

  async updateProcessEnvAndTriggerHooks () {
    await this.updateProcessEnv(this.getLoadSettings().env)
    this.shellEnvironmentLoaded = true
    this.emitter.emit('loaded-shell-environment')
    this.packages.triggerActivationHook('core:loaded-shell-environment')
  }

  /*
  Section: Messaging the User
  */

  // Essential: Visually and audibly trigger a beep.
  beep () {
    if (this.config.get('core.audioBeep')) this.applicationDelegate.playBeepSound()
    this.emitter.emit('did-beep')
  }

  // Essential: A flexible way to open a dialog akin to an alert dialog.
  //
  // If the dialog is closed (via `Esc` key or `X` in the top corner) without selecting a button
  // the first button will be clicked unless a "Cancel" or "No" button is provided.
  //
  // ## Examples
  //
  // ```coffee
  // atom.confirm
  //   message: 'How you feeling?'
  //   detailedMessage: 'Be honest.'
  //   buttons:
  //     Good: -> window.alert('good to hear')
  //     Bad: -> window.alert('bummer')
  // ```
  //
  // * `options` An {Object} with the following keys:
  //   * `message` The {String} message to display.
  //   * `detailedMessage` (optional) The {String} detailed message to display.
  //   * `buttons` (optional) Either an array of strings or an object where keys are
  //     button names and the values are callbacks to invoke when clicked.
  //
  // Returns the chosen button index {Number} if the buttons option is an array or the return value of the callback if the buttons option is an object.
  confirm (params = {}) {
    return this.applicationDelegate.confirm(params)
  }

  /*
  Section: Managing the Dev Tools
  */

  // Extended: Open the dev tools for the current window.
  //
  // Returns a {Promise} that resolves when the DevTools have been opened.
  openDevTools () {
    return this.applicationDelegate.openWindowDevTools()
  }

  // Extended: Toggle the visibility of the dev tools for the current window.
  //
  // Returns a {Promise} that resolves when the DevTools have been opened or
  // closed.
  toggleDevTools () {
    return this.applicationDelegate.toggleWindowDevTools()
  }

  // Extended: Execute code in dev tools.
  executeJavaScriptInDevTools (code) {
    return this.applicationDelegate.executeJavaScriptInWindowDevTools(code)
  }

  /*
  Section: Private
  */

  assert (condition, message, callbackOrMetadata) {
    if (condition) return true

    const error = new Error(`Assertion failed: ${message}`)
    Error.captureStackTrace(error, this.assert)

    if (callbackOrMetadata) {
      if (typeof callbackOrMetadata === 'function') {
        callbackOrMetadata(error)
      } else {
        error.metadata = callbackOrMetadata
      }
    }

    this.emitter.emit('did-fail-assertion', error)
    if (!this.isReleasedVersion()) throw error

    return false
  }

  loadThemes () {
    return this.themes.load()
  }

  // Notify the browser project of the window's current project path
  watchProjectPaths () {
    this.disposables.add(this.project.onDidChangePaths(() => {
      this.applicationDelegate.setRepresentedDirectoryPaths(this.project.getPaths())
    }))
  }

  setDocumentEdited (edited) {
    if (typeof this.applicationDelegate.setWindowDocumentEdited === 'function') {
      this.applicationDelegate.setWindowDocumentEdited(edited)
    }
  }

  setRepresentedFilename (filename) {
    if (typeof this.applicationDelegate.setWindowRepresentedFilename === 'function') {
      this.applicationDelegate.setWindowRepresentedFilename(filename)
    }
  }

  addProjectFolder () {
    return new Promise((resolve) => {
      this.pickFolder((selectedPaths) => {
        this.addToProject(selectedPaths || []).then(resolve)
      })
    })
  }

  async addToProject (projectPaths) {
    const state = await this.loadState(this.getStateKey(projectPaths))
    if (state && (this.project.getPaths().length === 0)) {
      this.attemptRestoreProjectStateForPaths(state, projectPaths)
    } else {
      projectPaths.map((folder) => this.project.addPath(folder))
    }
  }

  attemptRestoreProjectStateForPaths (state, projectPaths, filesToOpen = []) {
    const center = this.workspace.getCenter()
    const windowIsUnused = () => {
      for (let container of this.workspace.getPaneContainers()) {
        for (let item of container.getPaneItems()) {
          if (item instanceof TextEditor) {
            if (item.getPath() || item.isModified()) return false
          } else {
            if (container === center) return false
          }
        }
      }
      return true
    }

    if (windowIsUnused()) {
      this.restoreStateIntoThisEnvironment(state)
      return Promise.all(filesToOpen.map(file => this.workspace.open(file)))
    } else {
      const nouns = projectPaths.length === 1 ? 'folder' : 'folders'
      const choice = this.confirm({
        message: 'Previous automatically-saved project state detected',
        detailedMessage: `There is previously saved state for the selected ${nouns}. ` +
          `Would you like to add the ${nouns} to this window, permanently discarding the saved state, ` +
          `or open the ${nouns} in a new window, restoring the saved state?`,
        buttons: [
          '&Open in new window and recover state',
          '&Add to this window and discard state'
        ]})
      if (choice === 0) {
        this.open({
          pathsToOpen: projectPaths.concat(filesToOpen),
          newWindow: true,
          devMode: this.inDevMode(),
          safeMode: this.inSafeMode()
        })
        return Promise.resolve(null)
      } else if (choice === 1) {
        for (let selectedPath of projectPaths) {
          this.project.addPath(selectedPath)
        }
        return Promise.all(filesToOpen.map(file => this.workspace.open(file)))
      }
    }
  }

  restoreStateIntoThisEnvironment (state) {
    state.fullScreen = this.isFullScreen()
    for (let pane of this.workspace.getPanes()) {
      pane.destroy()
    }
    return this.deserialize(state)
  }

  showSaveDialog (callback) {
    callback(this.showSaveDialogSync())
  }

  showSaveDialogSync (options = {}) {
    this.applicationDelegate.showSaveDialog(options)
  }

  async saveState (options, storageKey) {
    if (this.enablePersistence && this.project) {
      const state = this.serialize(options)
      if (!storageKey) storageKey = this.getStateKey(this.project && this.project.getPaths())
      if (storageKey) {
        await this.stateStore.save(storageKey, state)
      } else {
        await this.applicationDelegate.setTemporaryWindowState(state)
      }
    }
  }

  loadState (stateKey) {
    if (this.enablePersistence) {
      if (!stateKey) stateKey = this.getStateKey(this.getLoadSettings().initialPaths)
      if (stateKey) {
        return this.stateStore.load(stateKey)
      } else {
        return this.applicationDelegate.getTemporaryWindowState()
      }
    } else {
      return Promise.resolve(null)
    }
  }

  async deserialize (state) {
    if (!state) return Promise.resolve()

    this.setFullScreen(state.fullScreen)

    const missingProjectPaths = []

    this.packages.packageStates = state.packageStates || {}

    let startTime = Date.now()
    if (state.project) {
      try {
        await this.project.deserialize(state.project, this.deserializers)
      } catch (error) {
        if (error.missingProjectPaths) {
          missingProjectPaths.push(...error.missingProjectPaths)
        } else {
          this.notifications.addError('Unable to deserialize project', {
            description: error.message,
            stack: error.stack
          })
        }
      }
    }

    this.deserializeTimings.project = Date.now() - startTime

    if (state.grammars) this.grammars.deserialize(state.grammars)

    startTime = Date.now()
    if (state.workspace) this.workspace.deserialize(state.workspace, this.deserializers)
    this.deserializeTimings.workspace = Date.now() - startTime

    if (missingProjectPaths.length > 0) {
      const count = missingProjectPaths.length === 1 ? '' : missingProjectPaths.length + ' '
      const noun = missingProjectPaths.length === 1 ? 'directory' : 'directories'
      const toBe = missingProjectPaths.length === 1 ? 'is' : 'are'
      const escaped = missingProjectPaths.map(projectPath => `\`${projectPath}\``)
      let group
      switch (escaped.length) {
        case 1:
          group = escaped[0]
          break
        case 2:
          group = `${escaped[0]} and ${escaped[1]}`
          break
        default:
          group = escaped.slice(0, -1).join(', ') + `, and ${escaped[escaped.length - 1]}`
      }

      this.notifications.addError(`Unable to open ${count}project ${noun}`, {
        description: `Project ${noun} ${group} ${toBe} no longer on disk.`
      })
    }
  }

  getStateKey (paths) {
    if (paths && paths.length > 0) {
      const sha1 = crypto.createHash('sha1').update(paths.slice().sort().join('\n')).digest('hex')
      return `editor-${sha1}`
    } else {
      return null
    }
  }

  getStorageFolder () {
    if (!this.storageFolder) this.storageFolder = new StorageFolder(this.getConfigDirPath())
    return this.storageFolder
  }

  getConfigDirPath () {
    if (!this.configDirPath) this.configDirPath = process.env.ATOM_HOME
    return this.configDirPath
  }

  getUserInitScriptPath () {
    const initScriptPath = fs.resolve(this.getConfigDirPath(), 'init', ['js', 'coffee'])
    return initScriptPath || path.join(this.getConfigDirPath(), 'init.coffee')
  }

  requireUserInitScript () {
    const userInitScriptPath = this.getUserInitScriptPath()
    if (userInitScriptPath) {
      try {
        if (fs.isFileSync(userInitScriptPath)) require(userInitScriptPath)
      } catch (error) {
        this.notifications.addError(`Failed to load \`${userInitScriptPath}\``, {
          detail: error.message,
          dismissable: true
        })
      }
    }
  }

  // TODO: We should deprecate the update events here, and use `atom.autoUpdater` instead
  onUpdateAvailable (callback) {
    return this.emitter.on('update-available', callback)
  }

  updateAvailable (details) {
    return this.emitter.emit('update-available', details)
  }

  listenForUpdates () {
    // listen for updates available locally (that have been successfully downloaded)
    this.disposables.add(this.autoUpdater.onDidCompleteDownloadingUpdate(this.updateAvailable.bind(this)))
  }

  setBodyPlatformClass () {
    this.document.body.classList.add(`platform-${process.platform}`)
  }

  setAutoHideMenuBar (autoHide) {
    this.applicationDelegate.setAutoHideWindowMenuBar(autoHide)
    this.applicationDelegate.setWindowMenuBarVisibility(!autoHide)
  }

  dispatchApplicationMenuCommand (command, arg) {
    let {activeElement} = this.document
    // Use the workspace element if body has focus
    if (activeElement === this.document.body) {
      activeElement = this.workspace.getElement()
    }
    this.commands.dispatch(activeElement, command, arg)
  }

  dispatchContextMenuCommand (command, ...args) {
    this.commands.dispatch(this.contextMenu.activeElement, command, args)
  }

  dispatchURIMessage (uri) {
    if (this.packages.hasLoadedInitialPackages()) {
      this.uriHandlerRegistry.handleURI(uri)
    } else {
      let subscription = this.packages.onDidLoadInitialPackages(() => {
        subscription.dispose()
        this.uriHandlerRegistry.handleURI(uri)
      })
    }
  }

  async openLocations (locations) {
    const needsProjectPaths = this.project && this.project.getPaths().length === 0
    const foldersToAddToProject = []
    const fileLocationsToOpen = []

    function pushFolderToOpen (folder) {
      if (!foldersToAddToProject.includes(folder)) {
        foldersToAddToProject.push(folder)
      }
    }

    for (var {pathToOpen, initialLine, initialColumn, forceAddToWindow} of locations) {
      if (pathToOpen && (needsProjectPaths || forceAddToWindow)) {
        if (fs.existsSync(pathToOpen)) {
          pushFolderToOpen(this.project.getDirectoryForProjectPath(pathToOpen).getPath())
        } else if (fs.existsSync(path.dirname(pathToOpen))) {
          pushFolderToOpen(this.project.getDirectoryForProjectPath(path.dirname(pathToOpen)).getPath())
        } else {
          pushFolderToOpen(this.project.getDirectoryForProjectPath(pathToOpen).getPath())
        }
      }

      if (!fs.isDirectorySync(pathToOpen)) {
        fileLocationsToOpen.push({pathToOpen, initialLine, initialColumn})
      }
    }

    let restoredState = false
    if (foldersToAddToProject.length > 0) {
      const state = await this.loadState(this.getStateKey(foldersToAddToProject))

      // only restore state if this is the first path added to the project
      if (state && needsProjectPaths) {
        const files = fileLocationsToOpen.map((location) => location.pathToOpen)
        await this.attemptRestoreProjectStateForPaths(state, foldersToAddToProject, files)
        restoredState = true
      } else {
        for (let folder of foldersToAddToProject) {
          this.project.addPath(folder)
        }
      }
    }

    if (!restoredState) {
      const fileOpenPromises = []
      for ({pathToOpen, initialLine, initialColumn} of fileLocationsToOpen) {
        fileOpenPromises.push(this.workspace && this.workspace.open(pathToOpen, {initialLine, initialColumn}))
      }
      await Promise.all(fileOpenPromises)
    }

    ipcRenderer.send('window-command', 'window:locations-opened')
  }

  resolveProxy (url) {
    return new Promise((resolve, reject) => {
      const requestId = this.nextProxyRequestId++
      const disposable = this.applicationDelegate.onDidResolveProxy((id, proxy) => {
        if (id === requestId) {
          disposable.dispose()
          resolve(proxy)
        }
      })

      return this.applicationDelegate.resolveProxy(requestId, url)
    })
  }
}

AtomEnvironment.version = 1
AtomEnvironment.prototype.saveStateDebounceInterval = 1000
module.exports = AtomEnvironment

/* eslint-disable */

// Preserve this deprecation until 2.0. Sorry. Should have removed Q sooner.
Promise.prototype.done = function (callback) {
  deprecate('Atom now uses ES6 Promises instead of Q. Call promise.then instead of promise.done')
  return this.then(callback)
}

/* eslint-enable */
