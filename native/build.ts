// Builds the native module into dist/native/<arch>/pear-native.node, where the
// main process loads it. Takes an optional Rust target for cross-compiling, as
// in `bun native/build.ts aarch64-unknown-linux-gnu`.
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { $ } from 'bun';

// Node's architecture and platform names and the matching Rust ones
const rustArchs: Record<string, string> = { arm64: 'aarch64', x64: 'x86_64' };
const rustSystems: Record<string, string> = {
  darwin: 'apple-darwin',
  linux: 'unknown-linux-gnu',
};
const target =
  process.argv[2] ??
  `${rustArchs[process.arch]}-${rustSystems[process.platform]}`;
const arch = Object.keys(rustArchs).find((key) =>
  target.startsWith(`${rustArchs[key]}-`),
);
const system = Object.values(rustSystems).find((value) =>
  target.endsWith(`-${value}`),
);
if (!arch || !system) throw new Error(`Unsupported target: ${target}`);

// An explicit target dir keeps the output path fixed even when CARGO_TARGET_DIR
// is set.
await $`cargo build --release --manifest-path ${join(import.meta.dirname, 'Cargo.toml')} --target ${target} --target-dir ${join(import.meta.dirname, 'target')}`;

const library =
  system === 'apple-darwin' ? 'libpear_native.dylib' : 'libpear_native.so';
const outputDir = join(import.meta.dirname, '..', 'dist', 'native', arch);
await mkdir(outputDir, { recursive: true });
await copyFile(
  join(import.meta.dirname, 'target', target, 'release', library),
  join(outputDir, 'pear-native.node'),
);
