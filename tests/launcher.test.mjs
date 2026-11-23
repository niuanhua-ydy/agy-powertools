import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  injectDebugArg,
  removeDebugArg,
  patchDesktopEntry,
  unpatchDesktopEntry,
  configureLaunchers,
  restoreLaunchers,
  resolveAntigravityExecutable,
  manualLaunchCommand,
  shouldPromptPostUpdate,
  scheduleRelaunchWithDebugPort,
  isRemoteSshEnvironment,
  resolveLocalFilePath,
  isWindowsRunnableFile,
  openLocalFile,
  copyLocalFile,
  readLocalFileForAttach
} from '../lib/launcher.mjs';
import { startSidecarWebUi, renderAuxPaneHtml } from '../lib/sidecar-ui.mjs';

test('injectDebugArg and removeDebugArg preserve user arguments and avoid duplicates', () => {
  assert.equal(injectDebugArg(''), '--remote-debugging-port=0');
  assert.equal(injectDebugArg('--wsl-distro=Ubuntu'), '--wsl-distro=Ubuntu --remote-debugging-port=0');
  assert.equal(injectDebugArg('--remote-debugging-port=9222'), '--remote-debugging-port=9222');
  assert.equal(removeDebugArg('--remote-debugging-port=0'), '');
  assert.equal(removeDebugArg('--wsl-distro=Ubuntu --remote-debugging-port=0 --flag'), '--wsl-distro=Ubuntu --flag');
  assert.equal(removeDebugArg('--remote-debugging-port=9222'), '--remote-debugging-port=9222');
});

test('Linux desktop launcher override patches and restores cleanly in sandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-launcher-linux-'));
  try {
    const home = join(root, 'home'), dataDir = join(root, 'data'), sysApps = join(root, 'sys-apps');
    mkdirSync(sysApps, { recursive: true });
    writeFileSync(join(sysApps, 'antigravity.desktop'), '[Desktop Entry]\nName=Antigravity\nExec=/opt/Antigravity/antigravity %U\nType=Application\n');
    const created = configureLaunchers({ home, dataDir, platform: 'linux', sandbox: true, systemApplicationsDir: sysApps });
    const userFile = join(home, '.local', 'share', 'applications', 'antigravity.desktop');
    assert.equal(created.updated.length, 1);
    assert.equal(created.macApp, undefined);
    assert.equal(created.iconConfigured, undefined);
    assert.equal(existsSync(join(home, 'Applications', 'Antigravity (Powertools).app')), false);
    assert.match(readFileSync(userFile, 'utf8'), /Exec=\/opt\/Antigravity\/antigravity --remote-debugging-port=0 %U/);

    const restored = restoreLaunchers({ home, dataDir, platform: 'linux', sandbox: true });
    assert.equal(restored.restored.length, 1);
    assert.equal(existsSync(userFile), false);

    mkdirSync(join(home, '.local', 'share', 'applications'), { recursive: true });
    writeFileSync(userFile, '[Desktop Entry]\nExec="/opt/Antigravity App/antigravity" --ozone-platform=wayland %U\n');
    configureLaunchers({ home, dataDir, platform: 'linux', sandbox: true });
    assert.match(readFileSync(userFile, 'utf8'), /Exec="\/opt\/Antigravity App\/antigravity" --remote-debugging-port=0 --ozone-platform=wayland %U/);
    restoreLaunchers({ home, dataDir, platform: 'linux', sandbox: true });
    assert.equal(readFileSync(userFile, 'utf8'), '[Desktop Entry]\nExec="/opt/Antigravity App/antigravity" --ozone-platform=wayland %U\n');
    assert.equal(patchDesktopEntry('[Desktop Entry]\nExec=/usr/bin/firefox %u\n').changed, false);
    assert.equal(unpatchDesktopEntry('[Desktop Entry]\nExec=/usr/bin/firefox %u\n').changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('macOS launcher app copies source icon when available, clears stale icon when absent, and removes on restore', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-launcher-mac-'));
  try {
    const home = join(root, 'home'), dataDir = join(root, 'data');
    const res = configureLaunchers({ home, dataDir, platform: 'darwin', sandbox: true });
    const appDir = join(home, 'Applications', 'Antigravity (Powertools).app');
    const plistPath = join(appDir, 'Contents', 'Info.plist');
    const iconPath = join(appDir, 'Contents', 'Resources', 'icon.icns');
    assert.equal(res.updated[0], appDir);
    assert.equal(res.macApp, appDir);
    assert.equal(res.iconConfigured, false);
    assert.equal(existsSync(iconPath), false);
    assert.equal(readFileSync(plistPath, 'utf8').includes('CFBundleIconFile'), false);
    assert.ok(readFileSync(join(appDir, 'Contents', 'MacOS', 'launcher'), 'utf8').includes('--remote-debugging-port=0'));

    const sourceApp = join(home, 'Applications', 'Antigravity.app');
    mkdirSync(join(sourceApp, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(sourceApp, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIconFile</key><string>CustomIcon</string></dict></plist>', 'utf8');
    writeFileSync(join(sourceApp, 'Contents', 'Resources', 'CustomIcon.icns'), 'FAKE_ICNS', 'utf8');

    const withIcon = configureLaunchers({ home, dataDir, platform: 'darwin', sandbox: true });
    assert.equal(withIcon.iconConfigured, true);
    assert.equal(withIcon.macApp, appDir);
    assert.equal(readFileSync(iconPath, 'utf8'), 'FAKE_ICNS');
    assert.ok(readFileSync(plistPath, 'utf8').includes('<key>CFBundleIconFile</key><string>icon.icns</string>'));
    assert.ok(readFileSync(join(appDir, 'Contents', 'MacOS', 'launcher'), 'utf8').includes(sourceApp.replace(/(["\\$`])/g, '\\$1')));

    rmSync(sourceApp, { recursive: true, force: true });
    const withoutIcon = configureLaunchers({ home, dataDir, platform: 'darwin', sandbox: true });
    assert.equal(withoutIcon.iconConfigured, false);
    assert.equal(existsSync(iconPath), false);
    assert.equal(readFileSync(plistPath, 'utf8').includes('CFBundleIconFile'), false);

    restoreLaunchers({ home, dataDir, platform: 'darwin', sandbox: true });
    assert.equal(existsSync(appDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows .lnk shortcuts targeting Antigravity.exe are updated and restored without touching unrelated shortcuts', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-launcher-win-'));
  try {
    const home = join(root, 'home'), dataDir = join(root, 'data');
    const desktop = join(home, 'Desktop');
    mkdirSync(desktop, { recursive: true });
    const fakeAgy = join(root, 'Antigravity.exe'), fakeOther = join(root, 'Other.exe');
    writeFileSync(fakeAgy, ''); writeFileSync(fakeOther, '');
    const agyLnk = join(desktop, 'Antigravity.lnk'), otherLnk = join(desktop, 'Other.lnk');
    spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ws = New-Object -ComObject WScript.Shell; $s1 = $ws.CreateShortcut($env:L1); $s1.TargetPath = $env:T1; $s1.Arguments = '--wsl-distro=Ubuntu'; $s1.Save(); $s2 = $ws.CreateShortcut($env:L2); $s2.TargetPath = $env:T2; $s2.Save()`
    ], { env: { ...process.env, L1: agyLnk, T1: fakeAgy, L2: otherLnk, T2: fakeOther }, windowsHide: true });

    const configured = configureLaunchers({ home, dataDir, platform: 'win32', sandbox: true });
    assert.deepEqual(configured.updated, [agyLnk]);
    const readArgs = lnk => spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut($env:L).Arguments`
    ], { env: { ...process.env, L: lnk }, encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(readArgs(agyLnk), '--wsl-distro=Ubuntu --remote-debugging-port=0');
    assert.equal(readArgs(otherLnk), '');

    const second = configureLaunchers({ home, dataDir, platform: 'win32', sandbox: true });
    assert.deepEqual(second.updated, []);

    const restored = restoreLaunchers({ home, dataDir, platform: 'win32', sandbox: true });
    assert.deepEqual(restored.restored, [agyLnk]);
    assert.equal(readArgs(agyLnk), '--wsl-distro=Ubuntu');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executable discovery, post-update prompt guards, and relaunch scheduling prevent loops', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-relaunch-'));
  try {
    const appRoot = join(root, 'Programs', 'antigravity');
    const binDir = join(appRoot, 'resources', 'bin');
    mkdirSync(binDir, { recursive: true });
    const exe = join(appRoot, 'Antigravity.exe'), lsExe = join(binDir, 'language_server.exe');
    writeFileSync(exe, ''); writeFileSync(lsExe, '');
    assert.equal(resolveAntigravityExecutable({ platform: 'win32', env: { ANTIGRAVITY_AGENTAPI_EXE: lsExe }, home: root, execPath: '' }), exe);
    assert.equal(resolveAntigravityExecutable({ platform: 'win32', env: {}, home: root, execPath: exe }), exe);
    assert.equal(manualLaunchCommand({ platform: 'win32', env: {}, home: root, execPath: exe }), `"${exe}" --remote-debugging-port=0`);

    const installDir = join(root, 'installed'), dataDir = join(root, 'data');
    mkdirSync(installDir, { recursive: true }); mkdirSync(dataDir, { recursive: true });
    const receipt = join(installDir, '.agy-install.json');
    writeFileSync(receipt, '{}');
    const now = Date.now();
    assert.equal(shouldPromptPostUpdate({ dataDir, installDir, env: {}, now }).reason, 'non-interactive');
    assert.equal(shouldPromptPostUpdate({ dataDir, installDir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5000', ELECTRON_OZONE_PLATFORM_HINT: 'headless' }, now }).reason, 'non-interactive');
    assert.equal(shouldPromptPostUpdate({ dataDir, installDir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5000' }, now }).reason, 'fresh-install');

    const oldDate = new Date(now - 5 * 60 * 1000);
    utimesSync(receipt, oldDate, oldDate);
    assert.equal(shouldPromptPostUpdate({ dataDir, installDir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5000' }, now }).prompt, true);

    const spawned = [];
    const res = scheduleRelaunchWithDebugPort({
      dataDir,
      home: root,
      platform: 'win32',
      env: { ANTIGRAVITY_AGENTAPI_EXE: lsExe, ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5000', ELECTRON_RUN_AS_NODE: '1' },
      spawnProcess(cmd, args, opts) { spawned.push({ cmd, args, opts }); return { unref() {} }; }
    });
    assert.equal(res.scheduled, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(spawned[0].opts.env.AGY_RELAUNCH_TARGET, exe);
    assert.ok(spawned[0].opts.env.AGY_RELAUNCH_SCRIPT.endsWith('relaunch-antigravity.ps1'));
    assert.ok(existsSync(spawned[0].opts.env.AGY_RELAUNCH_SCRIPT));
    assert.equal(spawned[0].opts.detached, undefined);
    assert.ok(spawned[0].args.includes('-EncodedCommand'));
    const encodedIdx = spawned[0].args.indexOf('-EncodedCommand');
    const decodedLauncher = Buffer.from(spawned[0].args[encodedIdx + 1], 'base64').toString('utf16le');
    assert.ok(decodedLauncher.includes('FindWindowSW'));
    assert.ok(decodedLauncher.includes('ShellExecute'));
    assert.ok(decodedLauncher.includes('CreateProcessW'));
    const psBody = readFileSync(spawned[0].opts.env.AGY_RELAUNCH_SCRIPT, 'utf8');
    assert.ok(psBody.includes('Start-Sleep -Milliseconds 350'));
    assert.ok(psBody.includes('--remote-debugging-port=0'));
    assert.ok(psBody.includes('Remove-Item -LiteralPath $PSCommandPath'));
    assert.equal(shouldPromptPostUpdate({ dataDir, installDir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5000' }, now: now + 1000 }).prompt, false);
    assert.equal(shouldPromptPostUpdate({ dataDir, installDir, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:6000' }, now: now + 1000 }).reason, 'cooldown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('macOS relaunch script waits for ancestor Antigravity process without pgrep -f and passes debug port', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-relaunch-mac-'));
  try {
    const appBundle = join(root, 'Antigravity.app');
    const binDir = join(appBundle, 'Contents', 'Resources', 'bin');
    mkdirSync(binDir, { recursive: true });
    const lsExe = join(binDir, 'language_server');
    writeFileSync(lsExe, '');

    const spawned = [];
    const res = scheduleRelaunchWithDebugPort({
      dataDir: join(root, 'data'),
      home: root,
      platform: 'darwin',
      env: { ANTIGRAVITY_AGENTAPI_EXE: lsExe, ELECTRON_RUN_AS_NODE: '1' },
      spawnProcess(cmd, args, opts) { spawned.push({ cmd, args, opts }); return { unref() {} }; }
    });

    assert.equal(res.scheduled, true);
    assert.equal(res.target, appBundle);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, 'sh');
    assert.equal(spawned[0].args[0], '-c');
    assert.equal(spawned[0].opts.detached, true);
    assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(spawned[0].opts.env.AGY_RELAUNCH_TARGET, appBundle);

    const script = spawned[0].args[1];
    assert.ok(script.includes("trap '' HUP TERM"));
    assert.ok(script.includes('/bin/ps -axo args='));
    assert.ok(!script.includes('pgrep -f'));
    assert.ok(script.includes('/usr/bin/open -n -a "$target" --args --remote-debugging-port=0 >/dev/null 2>&1'));
    assert.ok(!script.includes('--remote-debugging-port=0 >/dev/null 2>&1 &'));

    if (process.platform !== 'win32') {
      const check = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux relaunch script protects against HUP/TERM and matches executable via ps/awk without pgrep -f', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-relaunch-linux-'));
  try {
    const exe = join(root, 'antigravity');
    writeFileSync(exe, '');
    const spawned = [];
    const res = scheduleRelaunchWithDebugPort({
      dataDir: join(root, 'data'),
      home: root,
      platform: 'linux',
      env: { APPIMAGE: exe, ELECTRON_RUN_AS_NODE: '1' },
      spawnProcess(cmd, args, opts) { spawned.push({ cmd, args, opts }); return { unref() {} }; }
    });
    assert.equal(res.scheduled, true);
    assert.equal(res.target, exe);
    const script = spawned[0].args[1];
    assert.ok(script.includes("trap '' HUP TERM"));
    assert.ok(script.includes('ps -eo args='));
    assert.ok(!script.includes('pgrep -f'));
    assert.ok(script.includes('--remote-debugging-port=0'));
    if (process.platform !== 'win32') {
      const check = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Sidecar Aux Pane Web UI serves post-update prompt copy, enforces token auth, and triggers relaunch', async () => {
  const freePort = await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  let relaunched = 0, checked = 0, installedVer = '';
  const close = await startSidecarWebUi({
    port: freePort,
    token: 'secret-token',
    version: '2.13.0',
    getStatus: async () => ({
      healthy: false,
      compatibilityError: 'Antigravity compatibility: um (missing)',
      clientVersion: '2.34.0',
      connected: true,
      enabled: true,
      language: 'zh-CN'
    }),
    onRelaunch: async () => { relaunched++; return { scheduled: true }; },
    onCheckUpdate: async () => { checked++; return { status: 'available', version: '2.13.1', canInstall: true, releaseUrl: 'https://github.com/WhiteBr1ck/agy-powertools/releases/tag/v2.13.1' }; },
    onInstallUpdate: async ({ version }) => { installedVer = version; return { status: 'preparing', version }; },
    onUpdateStatus: async () => ({ status: installedVer ? 'installing' : 'idle', version: installedVer })
  });
  try {
    const html = renderAuxPaneHtml({ version: '2.13.0', language: 'zh-CN' });
    assert.ok(html.includes('需要重启 Antigravity 以启用 Powertools 插件'));
    assert.ok(html.includes('复制启动命令'));
    assert.ok(html.includes('检查插件更新'));
    assert.ok(html.includes('更新完成，请点击上方「立即重启启用」以启用新版本。'));
    assert.ok(html.includes('isStaleCompletedUpdate'));
    assert.ok(html.includes('复制诊断信息'));
    assert.ok(html.includes('id="mac-dock-hint"'));
    assert.ok(html.includes("data.platform === 'darwin'"));
    assert.ok(html.includes('拖入 Dock 栏替换原 Antigravity 图标'));
    assert.ok(html.includes('[hidden] { display: none !important; }'));
    assert.equal(html.includes('\u00b7'), false);
    const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript);
    new Function(inlineScript);

    const unauth = await fetch(`http://127.0.0.1:${freePort}/api/status`);
    assert.equal(unauth.status, 401);

    const statusRes = await fetch(`http://127.0.0.1:${freePort}/api/status?token=secret-token`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.healthy, false);
    assert.equal(statusJson.version, '2.13.0');
    assert.equal(statusJson.compatibilityError, 'Antigravity compatibility: um (missing)');
    assert.equal(statusJson.clientVersion, '2.34.0');

    const badPost = await fetch(`http://127.0.0.1:${freePort}/api/relaunch`, { method: 'POST' });
    assert.equal(badPost.status, 401);
    assert.equal(relaunched, 0);

    const okPost = await fetch(`http://127.0.0.1:${freePort}/api/relaunch`, {
      method: 'POST',
      headers: { 'x-sidecar-token': 'secret-token' }
    });
    assert.equal(okPost.status, 200);
    assert.equal(relaunched, 1);

    assert.equal((await fetch(`http://127.0.0.1:${freePort}/api/update/check`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${freePort}/api/update/install`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${freePort}/api/update/status`)).status, 401);

    const checkRes = await fetch(`http://127.0.0.1:${freePort}/api/update/check`, {
      method: 'POST',
      headers: { 'x-sidecar-token': 'secret-token', 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(checkRes.status, 200);
    assert.equal((await checkRes.json()).version, '2.13.1');
    assert.equal(checked, 1);

    const installRes = await fetch(`http://127.0.0.1:${freePort}/api/update/install`, {
      method: 'POST',
      headers: { 'x-sidecar-token': 'secret-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '2.13.1' })
    });
    assert.equal(installRes.status, 200);
    assert.equal(installedVer, '2.13.1');

    const updStatusRes = await fetch(`http://127.0.0.1:${freePort}/api/update/status?token=secret-token`);
    assert.equal(updStatusRes.status, 200);
    assert.equal((await updStatusRes.json()).status, 'installing');
  } finally {
    await close();
  }
});

test('resolveLocalFilePath parses local file URIs, strips fragments, and rejects remote hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-file-uri-'));
  try {
    const file = join(dir, 'sample #1.md');
    writeFileSync(file, 'hello', 'utf8');
    const fileUri = `${pathToFileURL(file).href}#L10-L20`;
    assert.equal(resolveLocalFilePath(fileUri), file);
    // Unescaped '#' in directory/file names (e.g. project-C#/app.exe) must not be truncated as URL hash
    const hashDir = join(dir, 'project-C#');
    mkdirSync(hashDir);
    const hashFile = join(hashDir, 'app.exe');
    writeFileSync(hashFile, 'bin', 'utf8');
    const rawHashUri = pathToFileURL(hashFile).href.replaceAll('%23', '#');
    assert.equal(resolveLocalFilePath(rawHashUri), hashFile);
    assert.equal(resolveLocalFilePath(`${rawHashUri}#L10-L20`), hashFile);
    // Antigravity URI serializer encodes '/' and second '#' inside the fragment as %2F and %23
    const fragStart = rawHashUri.indexOf('#');
    const encodedFragUri = `${rawHashUri.slice(0, fragStart + 1)}${rawHashUri.slice(fragStart + 1).replaceAll('/', '%2F')}`;
    assert.equal(resolveLocalFilePath(encodedFragUri), hashFile);
    assert.equal(resolveLocalFilePath(`${encodedFragUri}%23L10-L20`), hashFile);
    const readmeInHashDir = join(hashDir, 'README.md');
    writeFileSync(readmeInHashDir, '# hi', 'utf8');
    const rawReadmeUri = pathToFileURL(readmeInHashDir).href.replaceAll('%23', '#');
    assert.equal(resolveLocalFilePath(`${rawReadmeUri}#installation`), readmeInHashDir);
    const readmeFragStart = rawReadmeUri.indexOf('#');
    const encodedReadmeUri = `${rawReadmeUri.slice(0, readmeFragStart + 1)}${rawReadmeUri.slice(readmeFragStart + 1).replaceAll('/', '%2F')}%23installation`;
    assert.equal(resolveLocalFilePath(encodedReadmeUri), readmeInHashDir);
    assert.throws(() => resolveLocalFilePath('https://example.com/a.md'), /仅支持本地文件链接/);
    assert.throws(() => resolveLocalFilePath('file://evil.example/share/a.md'), /仅支持本机文件路径/);
    assert.throws(() => resolveLocalFilePath(''), /文件路径无效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openLocalFile dispatches platform commands and blocks runnable Windows files on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-open-file-'));
  try {
    const doc = join(dir, 'notes.md');
    const commaFile = join(dir, 'a,b.txt');
    const script = join(dir, 'run.js');
    writeFileSync(doc, '# hi', 'utf8');
    writeFileSync(commaFile, 'x', 'utf8');
    writeFileSync(script, 'console.log(1)', 'utf8');
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { unref() {} };
    };

    openLocalFile(pathToFileURL(doc).href, { action: 'open', platform: 'win32', spawnProcess: fakeSpawn });
    openLocalFile(pathToFileURL(doc).href, { action: 'reveal', platform: 'win32', spawnProcess: fakeSpawn });
    openLocalFile(pathToFileURL(commaFile).href, { action: 'reveal', platform: 'win32', spawnProcess: fakeSpawn });
    openLocalFile(pathToFileURL(doc).href, { action: 'reveal', platform: 'darwin', spawnProcess: fakeSpawn });
    openLocalFile(pathToFileURL(doc).href, { action: 'reveal', platform: 'linux', spawnProcess: fakeSpawn });
    openLocalFile(pathToFileURL(script).href, { action: 'reveal', platform: 'win32', spawnProcess: fakeSpawn });

    assert.deepEqual(calls[0], { cmd: 'explorer.exe', args: [doc], opts: { detached: true, stdio: 'ignore' } });
    assert.deepEqual(calls[1], { cmd: 'explorer.exe', args: [`/select,${doc}`], opts: { detached: true, stdio: 'ignore' } });
    assert.deepEqual(calls[2], { cmd: 'explorer.exe', args: [`/select,"${commaFile}"`], opts: { detached: true, stdio: 'ignore', windowsVerbatimArguments: true } });
    assert.deepEqual(calls[3], { cmd: 'open', args: ['-R', doc], opts: { detached: true, stdio: 'ignore' } });
    assert.deepEqual(calls[4], { cmd: 'xdg-open', args: [dir], opts: { detached: true, stdio: 'ignore' } });
    assert.deepEqual(calls[5], { cmd: 'explorer.exe', args: [`/select,${script}`], opts: { detached: true, stdio: 'ignore' } });

    assert.equal(isWindowsRunnableFile(script), true);
    assert.equal(isWindowsRunnableFile(doc), false);
    assert.throws(() => openLocalFile(pathToFileURL(script).href, { action: 'open', platform: 'win32', spawnProcess: fakeSpawn }), /可能直接执行/);
    assert.throws(() => openLocalFile(pathToFileURL(doc).href, { action: 'delete', spawnProcess: fakeSpawn }), /不支持的文件操作/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyLocalFile runs asynchronously across platforms with safe URI encoding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-copy-file-'));
  try {
    const file = join(dir, 'shot #1.png');
    writeFileSync(file, 'png', 'utf8');
    const fileUri = pathToFileURL(file).href;
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      let written = '';
      child.stdin = { on() {}, end(chunk) { written += String(chunk || ''); } };
      child.kill = () => {};
      const entry = { cmd, args, opts, get stdin() { return written; } };
      calls.push(entry);
      queueMicrotask(() => {
        if (cmd === 'wl-copy') child.emit('error', new Error('ENOENT'));
        else child.emit('close', 0);
      });
      return child;
    };

    await copyLocalFile(fileUri, { platform: 'win32', spawnProcess: fakeSpawn, env: {} });
    await copyLocalFile(fileUri, { platform: 'darwin', spawnProcess: fakeSpawn, env: {} });
    await copyLocalFile(fileUri, { platform: 'linux', spawnProcess: fakeSpawn, env: {} });

    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.equal(calls[0].opts.env.AGY_CLIPBOARD_PATH, file);
    assert.equal(calls[1].cmd, 'osascript');
    assert.equal(calls[1].opts.env.AGY_CLIPBOARD_PATH, file);
    assert.equal(calls[2].cmd, 'wl-copy');
    assert.equal(calls[3].cmd, 'xclip');
    assert.equal(calls[3].stdin, `${pathToFileURL(file).href}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isRemoteSshEnvironment detects headless SSH remote hosts without false positives on local desktop', () => {
  assert.equal(isRemoteSshEnvironment({ platform: 'linux', env: { SSH_CONNECTION: '1.2.3.4 22', ANTIGRAVITY_VSCODE_HOST: '1' } }), true);
  assert.equal(isRemoteSshEnvironment({ platform: 'linux', env: { ANTIGRAVITY_VSCODE_HOST: '1' } }), true);
  assert.equal(isRemoteSshEnvironment({ platform: 'linux', env: { SSH_CONNECTION: '1.2.3.4 22', DISPLAY: ':0' } }), false);
  assert.equal(isRemoteSshEnvironment({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), false);
  assert.equal(isRemoteSshEnvironment({ platform: 'win32', env: { SSH_CONNECTION: '1.2.3.4 22' } }), false);
  const html = renderAuxPaneHtml({ version: '2.12.8', language: 'zh-CN' });
  assert.ok(html.includes('当前处于 SSH 远端模式'));
});

test('scheduleRelaunchWithDebugPort reads saved proxy settings across platforms without creating shortcuts', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-relaunch-proxy-'));
  try {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      proxyEnabled: true,
      proxyUrl: 'socks5h://127.0.0.1:7897',
      proxyBypass: '192.168.0.0/16',
      proxyForceHttp1: true
    }));

    // Windows: reads settings.json automatically (so account switch & update relaunch preserve proxy)
    const winExe = join(root, 'AppData', 'Local', 'Programs', 'antigravity', 'Antigravity.exe');
    mkdirSync(join(root, 'AppData', 'Local', 'Programs', 'antigravity'), { recursive: true });
    writeFileSync(winExe, '');
    const winSpawned = [];
    const winRes = scheduleRelaunchWithDebugPort({
      dataDir,
      home: root,
      platform: 'win32',
      env: { LOCALAPPDATA: join(root, 'AppData', 'Local') },
      spawnProcess(cmd, args, opts) { winSpawned.push({ cmd, args, opts }); return { unref() {} }; }
    });
    assert.equal(winRes.proxyActive, true);
    const psBody = readFileSync(winSpawned[0].opts.env.AGY_RELAUNCH_SCRIPT, 'utf8');
    assert.ok(psBody.includes("$env:HTTPS_PROXY = 'socks5h://127.0.0.1:7897'"));
    assert.ok(psBody.includes("$env:NO_PROXY = 'localhost,127.0.0.1,::1,192.168.0.0/16'"));
    assert.ok(psBody.includes("$env:GODEBUG = 'http2client=0'"));
    assert.ok(psBody.includes("'--proxy-server=socks5://127.0.0.1:7897'"));
    assert.ok(psBody.includes("'--proxy-bypass-list=localhost;127.0.0.1;[::1];192.168.0.0/16'"));

    // macOS: injects env + --env flags + Chromium proxy args and clears helper vars
    const macApp = join(root, 'Antigravity.app');
    mkdirSync(join(macApp, 'Contents', 'Resources', 'bin'), { recursive: true });
    const macLs = join(macApp, 'Contents', 'Resources', 'bin', 'language_server');
    writeFileSync(macLs, '');
    const macSpawned = [];
    const macRes = scheduleRelaunchWithDebugPort({
      dataDir,
      home: root,
      platform: 'darwin',
      env: { ANTIGRAVITY_AGENTAPI_EXE: macLs },
      spawnProcess(cmd, args, opts) { macSpawned.push({ cmd, args, opts }); return { unref() {} }; }
    });
    assert.equal(macRes.proxyActive, true);
    assert.equal(macSpawned[0].opts.env.AGY_PROXY_URL, 'socks5h://127.0.0.1:7897');
    assert.equal(macSpawned[0].opts.env.AGY_PROXY_CHROME_SERVER, 'socks5://127.0.0.1:7897');
    assert.ok(macSpawned[0].args[1].includes('--env "HTTPS_PROXY=$p_url"'));
    assert.ok(macSpawned[0].args[1].includes('--proxy-server=$p_chrome'));
    assert.ok(macSpawned[0].args[1].includes('unset AGY_PROXY_URL'));

    // Linux: exports env + passes Chromium args
    const linExe = join(root, 'antigravity');
    writeFileSync(linExe, '');
    const linSpawned = [];
    const linRes = scheduleRelaunchWithDebugPort({
      dataDir,
      home: root,
      platform: 'linux',
      env: { APPIMAGE: linExe },
      spawnProcess(cmd, args, opts) { linSpawned.push({ cmd, args, opts }); return { unref() {} }; }
    });
    assert.equal(linRes.proxyActive, true);
    assert.ok(linSpawned[0].args[1].includes('export HTTP_PROXY="$p_url"'));
    assert.ok(linSpawned[0].args[1].includes('--proxy-server=$p_chrome'));

    // Disabled proxy: Windows relaunch explicitly clears stale proxy env vars
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ proxyEnabled: false, proxyUrl: 'http://127.0.0.1:7897' }));
    const offSpawned = [];
    const offRes = scheduleRelaunchWithDebugPort({
      dataDir,
      home: root,
      platform: 'win32',
      env: { LOCALAPPDATA: join(root, 'AppData', 'Local') },
      spawnProcess(cmd, args, opts) { offSpawned.push({ cmd, args, opts }); return { unref() {} }; }
    });
    assert.equal(offRes.proxyActive, false);
    const psOffBody = readFileSync(offSpawned[0].opts.env.AGY_RELAUNCH_SCRIPT, 'utf8');
    assert.ok(psOffBody.includes('Remove-Item Env:HTTP_PROXY'));
    assert.ok(!psOffBody.includes('--proxy-server='));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readLocalFileForAttach returns base64 media for images/PDFs, mentions for code/folders/oversized, and rejects missing or remote URIs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-attach-'));
  try {
    const imgPath = join(dir, 'sample.png');
    const imgBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(imgPath, imgBytes);
    const pdfPath = join(dir, 'spec.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n'));
    const codePath = join(dir, 'index.mjs');
    writeFileSync(codePath, 'export const ok = true;\n');
    const subDir = join(dir, 'folder');
    mkdirSync(subDir);

    const imgRes = readLocalFileForAttach(pathToFileURL(imgPath).href);
    assert.equal(imgRes.mode, 'media');
    assert.equal(imgRes.mimeType, 'image/png');
    assert.equal(imgRes.name, 'sample.png');
    assert.equal(imgRes.base64, imgBytes.toString('base64'));

    const pdfRes = readLocalFileForAttach(pathToFileURL(pdfPath).href);
    assert.equal(pdfRes.mode, 'media');
    assert.equal(pdfRes.mimeType, 'application/pdf');

    const oversizedRes = readLocalFileForAttach(pathToFileURL(imgPath).href, { maxMediaBytes: 4 });
    assert.equal(oversizedRes.mode, 'mention');
    assert.equal(oversizedRes.oversized, true);
    assert.equal(oversizedRes.base64, undefined);

    const codeRes = readLocalFileForAttach(pathToFileURL(codePath).href);
    assert.equal(codeRes.mode, 'mention');
    assert.equal(codeRes.kind, 'file');
    assert.equal(codeRes.isDirectory, false);

    const dirRes = readLocalFileForAttach(pathToFileURL(subDir).href);
    assert.equal(dirRes.mode, 'mention');
    assert.equal(dirRes.kind, 'directory');
    assert.equal(dirRes.isDirectory, true);

    assert.throws(() => readLocalFileForAttach(pathToFileURL(join(dir, 'missing.png')).href), /不存在/);
    assert.throws(() => readLocalFileForAttach('https://example.com/a.png'), /仅支持本地文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
