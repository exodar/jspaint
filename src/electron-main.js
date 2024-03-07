/*eslint-env node*/
const { app, shell, session, dialog, ipcMain, BrowserWindow } = require('electron');
const fs = require("fs");
const path = require("path");
const { ArgumentParser, SUPPRESS } = require('argparse');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) { // eslint-disable-line global-require
	app.quit();
	// `app.quit` does not immediately exit the process.
	return;
}

const parser = new ArgumentParser({
	prog: 'jspaint',
	description: 'MS Paint in JavaScript, running in Electron.',
});

parser.add_argument('file_path', {
	help: 'Image file to open',
	nargs: '?', // '?' indicates 0 or 1 arguments: it's optional
});

parser.add_argument('-v', '--version', {
	action: 'version',
	version: require('../package.json').version,
});

// Squirrel.Windows passes "-squirrel-firstrun" when the app is first run after being installed.
// Other Squirrel.Windows event argument are handled by `electron-squirrel-startup`, which returns whether it handled an event.
// This could be used to show a "Thanks for installing" message or some such, but just hide and ignore it for now.
parser.add_argument('-s', '--squirrel-firstrun', {
	help: SUPPRESS,
	action: 'store_true',
});

// Compare command line arguments:
// - unpackaged (in development):      "path/to/electron.exe" "." "maybe/a/file.png"
// - packaged (usually in production): "path/to/jspaint.exe" "maybe/a/file.png"
const { isPackaged } = app;
const args_array = process.argv.slice(isPackaged ? 1 : 2);
const args = parser.parse_args(args_array);

// After argument parsing that may have exited the app, handle single instance behavior.
// In other words, the priority is:
// - Squirrel event arguments (other than `--squirrel-firstrun`) which exit the app
// - `--help` or `--version` which print a message and exit the app
// - Opening an existing instance and exiting the app, forwarding arguments to the existing instance
// (If it quit because there was an existing instance before handling `--help`,
// you wouldn't get any help at the command line if the app was running.)
const got_single_instance_lock = app.requestSingleInstanceLock({
	argv: args_array,
});

// Note: When a second instance is opened, the `second-instance` event is emitted in the first instance.
// See handler below.
// Note: If the main process crashes during the second-instance event, the second instance will get the lock,
// even if the first instance is still running, showing an error dialog. 
if (!got_single_instance_lock) {
	console.log("Opening in existing instance; exiting this one.");
	app.quit();
	// `app.quit` does not immediately exit the process.
	// Return to avoid errors / main window briefly appearing.
	//   [52128:0304/194956.188:ERROR:cache_util_win.cc(20)] Unable to move the cache: Access is denied. (0x5)
	//   [52128:0304/194956.189:ERROR:cache_util.cc(145)] Unable to move cache folder C:\Users\Isaiah\AppData\Roaming\Electron\GPUCache to C:\Users\Isaiah\AppData\Roaming\Electron\old_GPUCache_000
	//   [52128:0304/194956.189:ERROR:disk_cache.cc(196)] Unable to create cache
	//   [52128:0304/194956.189:ERROR:shader_disk_cache.cc(613)] Shader Cache Creation failed: -2
	return;
} else {
	console.log("Got single instance lock.");
}

app.enableSandbox();
app.commandLine.appendSwitch('high-dpi-support', 1);
app.commandLine.appendSwitch('force-device-scale-factor', 1);

// Reloading and dev tools shortcuts
const isDev = process.env.ELECTRON_DEBUG === "1" || !isPackaged;
if (isDev) {
	require('electron-debug')({ showDevTools: false });
}

// @TODO: let user apply this setting somewhere in the UI (togglable)
// (Note: it would be better to use REG.EXE to apply the change, rather than a .reg file)
// This registry modification changes the right click > Edit option for images in Windows Explorer
const reg_contents = `Windows Registry Editor Version 5.00

[HKEY_CLASSES_ROOT\\SystemFileAssociations\\image\\shell\\edit\\command]
@="\\"${process.argv[0].replace(/\\/g, "\\\\")}\\" ${isPackaged ? "" : '\\".\\" '}\\"%1\\""
`; // oof that's a lot of escaping \\
////                                \\\\
//  /\   /\   /\   /\   /\   /\   /\  \\
// //\\ //\\ //\\ //\\ //\\ //\\ //\\ \\
//  ||   ||   ||   ||   ||   ||   ||  \\
//\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\
const reg_file_path = path.join(
	isPackaged ? path.dirname(process.argv[0]) : ".",
	`set-jspaint${isPackaged ? "" : "-DEV-MODE"}-as-default-image-editor.reg`
);
if (process.platform == "win32" && isPackaged) {
	fs.writeFile(reg_file_path, reg_contents, (err) => {
		if (err) {
			return console.error(err);
		}
	});
}

// In case of XSS holes, don't give the page free reign over the filesystem!
// Only allow allow access to files explicitly opened by the user.
const allowed_file_paths = [];

let initial_file_path;
if (args.file_path) {
	initial_file_path = path.resolve(args.file_path);
	allowed_file_paths.push(initial_file_path);
}

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
// @TODO: It's been several electron versions. I doubt this is still necessary. (It was from a boilerplate.)
let mainWindow;

const createWindow = () => {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		useContentSize: true,
		autoHideMenuBar: true, // it adds height for a native menu bar unless we hide it here
		// setMenu(null) below is too late; it's already decided on the size by then
		width: 800,
		height: 600,
		minWidth: 260,
		minHeight: 360,
		icon: path.join(__dirname, "../images/icons",
			process.platform === "win32" ?
				"jspaint.ico" :
				process.platform === "darwin" ?
					"jspaint.icns" :
					"48x48.png"
		),
		title: "JS Paint",
		webPreferences: {
			preload: path.join(__dirname, "/electron-injected.js"),
			contextIsolation: false,
		},
	});

	// @TODO: maybe use the native menu for the "Modern" theme, or a "Native" theme
	mainWindow.setMenu(null);

	// and load the index.html of the app.
	mainWindow.loadURL(`file://${__dirname}/../index.html`);

	// Emitted when the window is closed.
	mainWindow.on('closed', () => {
		// Dereference the window object, usually you would store windows
		// in an array if your app supports multi windows, this is the time
		// when you should delete the corresponding element.
		mainWindow = null;
	});

	// Emitted before the window is closed.
	mainWindow.on('close', (event) => {
		// Don't need to check mainWindow.isDocumentEdited(),
		// because the (un)edited state is handled by the renderer process, in are_you_sure().
		// Note: if the web contents are not responding, this will make the app harder to close.
		// Similarly, if there's an error, the app will be harder to close (perhaps worse as it's less likely to show a Not Responding dialog).
		// And this also prevents it from closing with Ctrl+C in the terminal, which is arguably a feature.
		// TODO: focus window if it's not focused, which can happen via right clicking the dock/taskbar icon, or Ctrl+C in the terminal
		// (but ideally not if it's going to close without prompting)
		mainWindow.webContents.send('close-window-prompt');
		event.preventDefault();
	});

	// Open links without target=_blank externally.
	mainWindow.webContents.on('will-navigate', (e, url) => {
		// check that the URL is not part of the app
		if (!url.includes("file://")) {
			e.preventDefault();
			shell.openExternal(url);
		}
	});
	// Open links with target=_blank externally.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		// check that the URL is not part of the app
		if (!url.includes("file://")) {
			shell.openExternal(url);
		}
		return { action: "deny" };
	});

	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				// connect-src needs data: for loading from localStorage,
				// and maybe blob: for loading from IndexedDB in the future.
				// (It uses fetch().)
				// Note: this should mirror the CSP in index.html, except maybe for firebase stuff.
				"Content-Security-Policy": [`
					default-src 'self';
					style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
					img-src 'self' data: blob: http: https:;
					font-src 'self' https://fonts.gstatic.com;
					connect-src * data: blob:;
				`],
			}
		})
	});
};
// Register listeners outside of createWindow to avoid them being added multiple times
// on macOS, where the app is not actually closed when the window is closed,
// and thus it can be opened multiple times from the same electron main process.
// (It causes an error in the case of handle() but not on().)
//     Error: Attempted to register a second handler for 'show-save-dialog'
// I'm using an indented block here just to avoid a large git diff, for now.
{
	ipcMain.on("get-env-info", (event) => {
		const env_info = {
			isDev,
			isMacOS: process.platform === "darwin",
			initialFilePath: initial_file_path,
		};
		event.returnValue = env_info;
		// event.returnValue is logged as undefined, so I guess it's a setter
		console.log("get-env-info: event.returnValue:", event.returnValue, "env_info:", env_info);
		// not sure if this is the best way to do this, but like,
		// it shouldn't open the file if the window is closed and re-opened, right?
		initial_file_path = null;
	});
	ipcMain.on("set-represented-filename", (event, filePath) => {
		if (allowed_file_paths.includes(filePath)) {
			mainWindow.setRepresentedFilename(filePath);
		}
	});
	ipcMain.on("set-document-edited", (event, isEdited) => {
		mainWindow.setDocumentEdited(isEdited);
	});
	ipcMain.handle("show-save-dialog", async (event, options) => {
		const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
			title: options.title,
			// defaultPath: options.defaultPath,
			defaultPath: options.defaultPath || path.basename(options.defaultFileName),
			filters: options.filters,
		});
		const fileName = path.basename(filePath);
		allowed_file_paths.push(filePath);
		return { filePath, fileName, canceled };
	});
	ipcMain.handle("show-open-dialog", async (event, options) => {
		const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
			title: options.title,
			defaultPath: options.defaultPath,
			filters: options.filters,
			properties: options.properties,
		});
		allowed_file_paths.push(...filePaths);
		return { filePaths, canceled };
	});
	ipcMain.handle("write-file", async (event, file_path, data) => {
		if (!allowed_file_paths.includes(file_path)) {
			return { responseCode: "ACCESS_DENIED" };
		}
		// make sure data is an ArrayBuffer, so you can't use an options object for (unknown) evil reasons
		if (data instanceof ArrayBuffer) {
			try {
				await fs.promises.writeFile(file_path, Buffer.from(data));
			} catch (error) {
				return { responseCode: "WRITE_FAILED", error };
			}
			return { responseCode: "SUCCESS" };
		} else {
			return { responseCode: "INVALID_DATA" };
		}
	});
	ipcMain.handle("read-file", async (event, file_path) => {
		if (!allowed_file_paths.includes(file_path)) {
			return { responseCode: "ACCESS_DENIED" };
		}
		try {
			const buffer = await fs.promises.readFile(file_path);
			return { responseCode: "SUCCESS", data: new Uint8Array(buffer), fileName: path.basename(file_path) };
		} catch (error) {
			return { responseCode: "READ_FAILED", error };
		}
	});
	ipcMain.handle("set-wallpaper", async (event, data) => {
		const image_path = path.join(app.getPath("userData"), "bg.png"); // Note: used without escaping
		if (!(data instanceof ArrayBuffer)) {
			return { responseCode: "INVALID_DATA" };
		}
		data = new Uint8Array(data);
		const png_magic_bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
		for (let i = 0; i < png_magic_bytes.length; i++) {
			if (data[i] !== png_magic_bytes[i]) {
				console.log("Found bytes:", data.slice(0, png_magic_bytes.length), "but expected:", png_magic_bytes);
				return { responseCode: "INVALID_PNG_DATA" };
			}
		}
		try {
			await fs.promises.writeFile(image_path, Buffer.from(data));
		} catch (error) {
			return { responseCode: "WRITE_TEMP_PNG_FAILED", error };
		}

		// The wallpaper module actually has support for Xfce, but it's not general enough.
		const bash_for_xfce = `xfconf-query -c xfce4-desktop -l | grep last-image | while read path; do xfconf-query -c xfce4-desktop -p $path -s '${image_path}'; done`;
		const { lookpath } = require("lookpath");
		if (await lookpath("xfconf-query") && await lookpath("grep")) {
			const exec = require("util").promisify(require('child_process').exec);
			try {
				await exec(bash_for_xfce);
			} catch (error) {
				console.error("Error setting wallpaper for Xfce:", error);
				return { responseCode: "XFCONF_FAILED", error };
			}
			return { responseCode: "SUCCESS" };
		} else {
			// Note: { scale: "center" } is only supported on macOS.
			// I worked around this by providing an image with a transparent margin on other platforms,
			// in setWallpaperCentered.
			return new Promise((resolve, reject) => {
				require("wallpaper").set(image_path, { scale: "center" }, error => {
					if (error) {
						resolve({ responseCode: "SET_WALLPAPER_FAILED", error });
					} else {
						resolve({ responseCode: "SUCCESS" });
					}
				});
			});
			// Newer promise-based wallpaper API that I can't import:
			// try {
			// 	await setWallpaper(image_path, { scale: "center" });
			// } catch (error) {
			// 	return { responseCode: "SET_WALLPAPER_FAILED", error };
			// }
			// return { responseCode: "SUCCESS" };
		}
	});
}

// Quit when all windows are closed.
app.on('window-all-closed', () => {
	// On OS X it is common for applications and their menu bar
	// to stay active until the user quits explicitly with Cmd + Q
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

async function activate_app() {
	await app.whenReady();
	if (mainWindow) {
		console.log("focusing existing window");
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	} else {
		createWindow();
		console.log("created new window:", mainWindow);
	}
}

function open_file_in_app(file_path) {
	allowed_file_paths.push(file_path);
	if (mainWindow) {
		console.log("sending open-file to mainWindow");
		mainWindow.webContents.send('open-file', file_path);
	} else {
		console.log("setting initial_file_path");
		initial_file_path = file_path;
	}
}

// Should this be delayed until will-finish-launching like in this example?
// https://gist.github.com/sonnypgs/de2b6a4a4936d5b8e0fe43946002964a
// Note: to test this, the app needs to be packaged, as far as I know,
// since Info.plist tells macOS what files can be opened with the app.
// Running in development mode, the dock icon doesn't accept files.
app.on('open-file', (event, file_path) => {
	// Emitted when dragging a file onto the dock on macOS (when the app was not running),
	// or when opening a file from the file manager (when the app is already running).

	// NOTE: if implementing support for multiple editor windows, make sure not to create two windows at startup.
	// Right now activate_app checks for an existing window, and both 'open-file' and the initial general window creation use it.

	event.preventDefault();
	console.log("open-file", file_path);
	activate_app();
	open_file_in_app(file_path);
});

app.on('second-instance', (event, uselessCorruptedArgv, workingDirectory, additionalData) => {
	// Someone tried to run a second instance, we should focus our window,
	// and handle the file path if there is one.
	// Note: the second-instance event sends a broken argv which may rearrange and add extra arguments,
	// so we have to use the additionalData object, passed from requestSingleInstanceLock.
	// This hack is recommended in the docs: https://www.electronjs.org/docs/api/app#event-second-instance
	console.log("second-instance", uselessCorruptedArgv, workingDirectory, additionalData);
	activate_app();
	// Here I am being glad there's at least an official workaround for the broken argv,
	// so I can finally be done with SOME of this complicated nonsense.
	// I installed the app, tested opening files by dragging onto the shortcut in the file manager, that worked,
	// but then launching the app from the start menu (i.e. without a file) gave me an error message:
	//   TypeError: Cannot read properties of null (reading 'argv')
	// `additionalData` doesn't always exist!?
	// In fact, I can reproduce it in development mode too:
	//   Terminal 1:  ./node_modules/electron/dist/electron.exe . images/icons/512x512.png
	//   Terminal 2:  ./node_modules/electron/dist/electron.exe .
	// Is `additionalData` of `{argv: []}` lost and converted to null?
	// Is it not truthy enough? (𖦹ᯅ𖦹)
	// What is truth, anyways? (◎~◎)
	if (!additionalData) {
		console.log("second-instance: no additionalData");
		return;
	}
	const argv = additionalData.argv;
	const args = parser.parse_args(argv);
	if (args.file_path) {
		const file_path = path.resolve(workingDirectory, args.file_path);
		console.log("opening file from second instance:", file_path);
		open_file_in_app(file_path);
	}
});

// On OS X it's common to re-create a window in the app when the
// dock icon is clicked and there are no other windows open.
// Don't really need focus/restore logic of activate_app here,
// as I believe macOS will do that, but it's simpler to just call activate_app.
app.on('activate', activate_app);

// Create the main window when Electron is ready.
// Use `activate_app` instead of `app.on('ready', createWindow)`, because it includes a check for an existing window,
// so it could avoid potentially creating two windows at startup (though I suspect the event order would prevent that).
activate_app();
