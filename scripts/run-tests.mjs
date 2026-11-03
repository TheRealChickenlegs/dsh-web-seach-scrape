/**
 * Run the tests locally across platforms and Node versions.
 *
 * Why not just `node --test "test/*.test.mjs"`:
 *   - `node --test` **glob expansion** only arrived in Node 21; Node 20 treats `test/*.test.mjs`
 *     as a literal path and reports `Could not find '.../test/*.test.mjs'`.
 *   - Removing the quotes and letting the shell expand is not reliable either: npm scripts run
 *     through cmd on Windows (no glob expansion) and sh on POSIX (expansion), so behaviour differs.
 *
 * So this lists the test files itself and hands **explicit paths** to `--test` — supported on
 * Node 18+, with identical behaviour on Windows and Linux.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testDir, name))

if (files.length === 0) {
  console.error(`No *.test.mjs files found in ${testDir}`)
  process.exit(1)
}

// stdio: 'inherit' — let the node:test reporter write straight to the terminal (piping loses colour and progress).
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
})

if (result.error) {
  console.error(`Failed to start the test process: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
