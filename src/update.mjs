// Keeps the helper current. Claude Code's own auto-update is off for marketplaces like
// this one until a user turns it on in /plugin, so the helper asks for updates itself,
// through the same public commands a person would run.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { VERSION, isNewer } from './version.mjs';

const exec = promisify(execFile);
const MARKETPLACE = 'venes';
const PLUGIN_ID = 'venes@venes';
const CLAUDE_TIMEOUT_MS = 150_000;
const FIRST_CHECK_MS = 5 * 60_000;
const CHECK_MS = 6 * 60 * 60_000;
const QUIET_CHECK_MS = 30_000;

async function runClaude(args) {
  const { stdout } = await exec('claude', args, { timeout: CLAUDE_TIMEOUT_MS });
  return stdout;
}

function launchSetup({ installPath }) {
  spawn(process.execPath, [path.join(installPath, 'cli/venes.mjs'), 'setup'], { detached: true, stdio: 'ignore' }).unref();
}

// Respects the switches that turn off Claude Code's own plugin updates.
export function autoUpdateEnabled(paths, env = process.env) {
  if (fs.existsSync(paths.noAutoUpdate)) return false;
  if (env.FORCE_AUTOUPDATE_PLUGINS) return true;
  return !(env.DISABLE_UPDATES || env.DISABLE_AUTOUPDATER || env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
}

export function newerInstall(listing) {
  const install = JSON.parse(listing).find(plugin => plugin.id === PLUGIN_ID);
  return install && isNewer(install.version, VERSION) ? install : undefined;
}

export function startAutoUpdate(store, paths, { run = runClaude, launch = launchSetup, firstCheckMs = FIRST_CHECK_MS, env = process.env } = {}) {
  let found;
  let checking;

  const attempt = async args => {
    try {
      return await run(args);
    } catch (error) {
      console.error(`update: claude ${args.join(' ')}: ${error.message}`); // offline, usually
      return undefined;
    }
  };

  // The new version takes over by running its own setup, which replaces this process.
  const switchWhenQuiet = () => {
    if (!found || !store.isQuiet()) return;
    console.error(`update: switching to ${found.version}`);
    launch(found);
    found = undefined;
  };

  const check = async () => {
    // plugin update alone doesn't refresh the marketplace, so it would never see a release.
    await attempt(['plugin', 'marketplace', 'update', MARKETPLACE]);
    await attempt(['plugin', 'update', PLUGIN_ID, '--json']);
    // Read back rather than trust the update's result: the newer copy may have come
    // from /plugin, or from Claude Code's auto-update if the user turned it on.
    const listing = await attempt(['plugin', 'list', '--json']);
    if (listing) found = newerInstall(listing) ?? found;
    const available = found?.version;
    switchWhenQuiet();
    return available;
  };

  const checkOnce = () => {
    checking ??= check().finally(() => { checking = undefined; });
    return checking;
  };

  const scheduled = () => { if (autoUpdateEnabled(paths, env)) checkOnce(); };
  const timers = [setTimeout(scheduled, firstCheckMs), setInterval(scheduled, CHECK_MS), setInterval(switchWhenQuiet, QUIET_CHECK_MS)];
  for (const timer of timers) timer.unref();

  return {
    check: checkOnce,
    stop() { for (const timer of timers) clearTimeout(timer); },
  };
}
