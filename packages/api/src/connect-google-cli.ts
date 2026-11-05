import { openBrowser, runConnectCli } from './connect-google.js';

// Process entry of `pnpm connect:google` and `pnpm secret:put`. A separate file, as
// server.ts is, because a main-module guard breaks under a symlinked release path.
process.exitCode = await runConnectCli(process.argv.slice(2), {
  env: process.env,
  stdout: line => { process.stdout.write(line + '\n'); },
  stderr: line => { process.stderr.write(line + '\n'); },
  stdin: () => process.stdin,
  fetch: globalThis.fetch,
  openBrowser,
});
