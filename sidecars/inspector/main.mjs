import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppDataDir, listRecentConversations, resolveConversationId, parseSessionData, exportTranscript } from '../../lib/session-parser.mjs';
import { startNativeIntegration } from '../../lib/native-host.mjs';
import { serveRuntime } from '../../lib/runtime-control.mjs';
import { installationPaths } from '../../lib/lifecycle.mjs';
import { createSettingsStore } from '../../lib/settings.mjs';
import { configureLaunchers, isRemoteSshEnvironment, manualLaunchCommand, maybePromptPostUpdateRelaunch, scheduleRelaunchWithDebugPort } from '../../lib/launcher.mjs';
import { startSidecarWebUi } from '../../lib/sidecar-ui.mjs';
import { checkForUpdates } from '../../lib/updates.mjs';
import { startUpdate, updateStatus } from '../../lib/update-manager.mjs';

export { getAppDataDir, listRecentConversations, resolveConversationId, parseSessionData, exportTranscript };

export function buildRuntimeHealth({ health = {}, enabled = true, remoteSsh = false } = {}) {
  const isEnabled = enabled !== false;
  const healthy = Boolean(health.healthy);
  const connected = Boolean(health.connected);
  const compatibilityError = typeof health.compatibilityError === 'string' ? health.compatibilityError : '';
  const runtimeReady = Boolean(healthy || !isEnabled || remoteSsh || (!connected && !compatibilityError));
  return {
    ...health,
    healthy,
    connected,
    compatibilityError,
    enabled: isEnabled,
    mode: remoteSsh ? 'ssh-remote' : 'local',
    runtimeReady
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const paths = installationPaths();
  const settings = createSettingsStore();
  const remoteSsh = isRemoteSshEnvironment();
  let missingPortPolls = 0, shortcutsHealed = false, everConnectedDebugPort = false;
  const stop = startNativeIntegration({
    parseSessionData,
    onDebugPortReady() {
      everConnectedDebugPort = true;
      missingPortPolls = 0;
    },
    onMissingDebugPort() {
      if (remoteSsh || everConnectedDebugPort) return;
      missingPortPolls++;
      if (!shortcutsHealed) {
        shortcutsHealed = true;
        try { configureLaunchers({ home: paths.home, dataDir: paths.data }); } catch {}
      }
      if (missingPortPolls >= 2) {
        const current = settings.get();
        if (current.enabled !== false) {
          maybePromptPostUpdateRelaunch({
            dataDir: paths.data,
            installDir: paths.installed,
            language: current.language || 'zh-CN',
            home: paths.home
          });
        }
      }
    }
  });
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const closeWebUi = await startSidecarWebUi({
    version,
    getStatus: async () => {
      const current = settings.get();
      const health = await stop.health();
      return {
        healthy: health.healthy,
        compatibilityError: health.compatibilityError || '',
        clientVersion: health.clientVersion || '',
        connected: Boolean(health.connected),
        enabled: current.enabled !== false,
        language: current.language || 'zh-CN',
        platform: process.platform,
        macLauncherApp: process.platform === 'darwin' ? join(paths.home, 'Applications', 'Antigravity (Powertools).app') : '',
        mode: remoteSsh ? 'ssh-remote' : 'local',
        manualCommand: remoteSsh ? '' : manualLaunchCommand({ home: paths.home }),
        update: updateStatus()
      };
    },
    onRelaunch: () => remoteSsh ? { scheduled: false, reason: 'ssh-remote' } : scheduleRelaunchWithDebugPort({ dataDir: paths.data, home: paths.home }),
    onCheckUpdate: () => checkForUpdates({ currentVersion: version }),
    onInstallUpdate: ({ version: expectedVersion } = {}) => startUpdate({ currentVersion: version, expectedVersion }),
    onUpdateStatus: () => updateStatus()
  }).catch(() => async () => {});
  const close = await serveRuntime({
    directory: join(paths.data, 'runtime'),
    version,
    stop,
    health: async () => buildRuntimeHealth({ health: await stop.health(), enabled: settings.get().enabled !== false, remoteSsh })
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await stop(); await closeWebUi(); await close(); process.exit(0); });
}
