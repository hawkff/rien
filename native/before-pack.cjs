// electron-builder runs this before packing each platform and architecture, so
// every package gets the native module built for its own target.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

// electron-builder's Arch enum
const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};

module.exports = async function beforePack(context) {
  const platform = `${context.electronPlatformName}-${archNames[context.arch]}`;
  const target = targets[platform];
  if (!target) throw new Error(`No native module target for ${platform}`);
  execFileSync('bun', [join(__dirname, 'build.ts'), target], {
    stdio: 'inherit',
  });
};
