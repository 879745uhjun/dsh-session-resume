#!/usr/bin/env node
/**
 * Install dsh-session-resume into a DSH profile with pnpm.
 *
 * Two manifest entries, both required: a "link:" dependency so the package
 * resolves from the profile, and the name in dsh.profile.bundles so the loader
 * loads it. The loader resolves plugin names as packages, so bundles is the
 * registry a plugin must appear in.
 *
 *   node install.mjs                 # install into ~/.dsh/profiles/desktop
 *   node install.mjs --dry           # print what would change
 *   node install.mjs --profile <dir> # another profile
 *   node install.mjs --selftest-fail # prove the rollback path
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NAME = 'dsh-session-resume'
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const selftestFail = args.includes('--selftest-fail')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0
  ? resolve(args[profileIndex + 1])
  : join(homedir(), '.dsh', 'profiles', 'desktop')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const manifest = join(profile, 'package.json')
const backup = join(profile, 'package.json.bak-session-resume-' + stamp)

function run(command, commandArgs, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit', shell: false })
    child.on('error', rejectRun)
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(command + ' exited with ' + code))))
  })
}

const parsed = JSON.parse(await readFile(manifest, 'utf8'))
parsed.dependencies ??= {}
const wanted = 'link:' + HERE.replace(/\\/g, '/')
const dependencyChange = parsed.dependencies[NAME] !== wanted
const listedBundles = Array.isArray(parsed.dsh?.profile?.bundles) ? [...parsed.dsh.profile.bundles] : []
const bundlesChange = !listedBundles.includes(NAME)
const bundlesAfter = bundlesChange ? [...listedBundles, NAME] : listedBundles

console.log('profile    :', profile)
console.log('dependency :', dependencyChange ? 'set ' + wanted : 'already set')
console.log('bundles    :', bundlesChange ? 'add ' + NAME : 'already listed')
console.log('bundles    :', JSON.stringify(listedBundles), '->', JSON.stringify(bundlesAfter))
if (dry) {
  console.log('backup     :', backup)
  console.log('dry run    : nothing written')
  process.exit(0)
}
if (!dependencyChange && !bundlesChange) {
  console.log('nothing    : to do; restart DSH if the plugin is not loaded yet')
  process.exit(0)
}

await copyFile(manifest, backup)
parsed.dependencies[NAME] = wanted
parsed.dsh ??= {}
parsed.dsh.profile ??= {}
parsed.dsh.profile.bundles ??= []
if (!parsed.dsh.profile.bundles.includes(NAME)) parsed.dsh.profile.bundles.push(NAME)
await writeFile(manifest, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
console.log('backup     :', backup)
console.log('manifest   : written (dependency + bundles)')

const pnpm = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
try {
  if (selftestFail) throw new Error('selftest: forced install failure')
  await run(process.execPath, [pnpm, 'install', '--prefer-offline'], profile)
} catch (error) {
  // The manifest must never keep a bundle whose package failed to install.
  await copyFile(backup, manifest)
  console.error('manifest   : restored from', backup)
  console.error('install failed:', error.message)
  process.exit(1)
}
console.log('')
console.log('installed. restart DSH, then the resume dialog appears when a turn was interrupted.')
console.log('rollback   : copy "' + backup + '" over "' + manifest + '" and run pnpm install again')
