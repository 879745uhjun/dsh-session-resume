#!/usr/bin/env node
/**
 * Offline installer for dsh-session-resume — run it with DSH CLOSED.
 *
 * While DSH is running it watches its own profile: creating a package inside
 * profiles/<name>/node_modules is picked up mid-copy and the write blocks.
 * Quit DSH, run this, start DSH again.
 *
 * The manifest gets two entries, and both are required: a "link:" dependency so
 * the package resolves, and its name in dsh.profile.bundles so the loader loads
 * it (the loader resolves plugin names as packages; bundles is its registry).
 *
 *   node install-offline.mjs              # install into ~/.dsh/profiles/desktop
 *   node install-offline.mjs --dry        # show the plan only
 *   node install-offline.mjs --profile <dir>
 *   node install-offline.mjs --selftest-fail   # prove the rollback path
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NAME = 'dsh-session-resume'
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const selftestFail = args.includes('--selftest-fail')
const index = args.indexOf('--profile')
const profile = index >= 0 ? resolve(args[index + 1]) : join(homedir(), '.dsh', 'profiles', 'desktop')
const manifest = join(profile, 'package.json')
const target = join(profile, 'node_modules', NAME)

if (!existsSync(manifest)) {
  console.error('no profile manifest at', manifest)
  process.exit(1)
}

const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
parsed.dependencies ??= {}
const wanted = 'link:' + HERE.replace(/\\/g, '/')
const dependencyChange = parsed.dependencies[NAME] !== wanted
const listedBundles = Array.isArray(parsed.dsh?.profile?.bundles) ? [...parsed.dsh.profile.bundles] : []
const bundlesChange = !listedBundles.includes(NAME)
const bundlesAfter = bundlesChange ? [...listedBundles, NAME] : listedBundles
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = manifest + '.bak-session-resume-' + stamp

console.log('profile    :', profile)
console.log('dependency :', dependencyChange ? 'set ' + wanted : 'already set')
console.log('bundles    :', bundlesChange ? 'add ' + NAME : 'already listed')
console.log('bundles    :', JSON.stringify(listedBundles), '->', JSON.stringify(bundlesAfter))
console.log('copy       :', HERE, '->', target)
if (dry) {
  console.log('dry run    : nothing written')
  process.exit(0)
}

mkdirSync(join(profile, 'node_modules'), { recursive: true })
if (dependencyChange || bundlesChange) {
  copyFileSync(manifest, backup)
  parsed.dependencies[NAME] = wanted
  parsed.dsh ??= {}
  parsed.dsh.profile ??= {}
  parsed.dsh.profile.bundles ??= []
  if (!parsed.dsh.profile.bundles.includes(NAME)) parsed.dsh.profile.bundles.push(NAME)
  writeFileSync(manifest, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
  console.log('backup     :', backup)
  console.log('manifest   : written (dependency + bundles)')
} else {
  console.log('manifest   : unchanged')
}

try {
  if (selftestFail) throw new Error('selftest: forced copy failure')
  rmSync(target, { recursive: true, force: true })
  cpSync(HERE, target, {
    recursive: true,
    filter: (source) => !source.includes('node_modules') && !source.endsWith('.git'),
  })
  if (!existsSync(join(target, 'package.json'))) throw new Error('the copy did not land')
} catch (error) {
  // A dependency or bundle registered without its files would break the next
  // profile load, so put the manifest back exactly as it was.
  if (existsSync(backup)) {
    copyFileSync(backup, manifest)
    console.error('manifest   : restored from', backup)
  } else {
    console.error('manifest   : untouched (no changes were written)')
  }
  console.error('install failed:', error.message)
  process.exit(1)
}
console.log('copied     : ok')
console.log('')
console.log('done. start DSH — the resume dialog appears when a turn was interrupted.')
