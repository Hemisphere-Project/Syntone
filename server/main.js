// Entry point: `npm start`, and what pm2 runs. Kept apart from index.js because a process manager
// loads the script from its own wrapper, so "was this file run directly?" cannot be asked there.
import { start } from './index.js'

const { port } = await start()
console.log(`syntone relay listening on :${port}  (lab: /lab/)`)
