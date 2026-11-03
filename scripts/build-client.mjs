/**
 * Copy the hand-authored browser bundle into lib/.
 *
 * The client half deliberately has no bundler: it is plain JS that DSH's module loader
 * serves directly and that uses the platform-provided React. Keeping the source in src/
 * and copying it here makes `npm run build` produce a complete package.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

mkdirSync('lib', { recursive: true })
copyFileSync(path.join('src', 'client.js'), path.join('lib', 'client.js'))
console.log('built lib/client.js')
