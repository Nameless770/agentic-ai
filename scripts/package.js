'use strict';

// Builds dist/Claude Buddy-win32-x64/Claude Buddy.exe.
// (Done in JS rather than an npm one-liner: cmd.exe strips the "^" from
// regex patterns, which made the packager drop node_modules/*/dist folders.)

const path = require('path');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');

packager({
  dir: root,
  name: 'Claude Buddy',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(root, 'assets', 'icon.ico'),
  out: path.join(root, 'dist'),
  overwrite: true,
  asar: true,
  prune: true,
  // Paths are relative to the project folder, with forward slashes.
  ignore: [/^\/scripts(\/|$)/, /^\/test(\/|$)/, /^\/README\.md$/, /^\/package-lock\.json$/],
  win32metadata: {
    CompanyName: 'Claude Buddy',
    FileDescription: 'Claude Buddy',
    ProductName: 'Claude Buddy',
    InternalName: 'Claude Buddy',
  },
})
  .then((paths) => console.log(`Built: ${paths.join(', ')}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
