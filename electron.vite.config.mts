import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import builtinModules from 'builtin-modules';
import {
  defineConfig,
  type MainViteConfig,
  type PreloadViteConfig,
  type RendererViteConfig,
} from 'electron-vite';
import { type Plugin, withFilter } from 'vite';
import Inspect from 'vite-plugin-inspect';
import viteResolve from 'vite-plugin-resolve';
import solidPlugin from 'vite-plugin-solid';

import { i18nImporter } from './vite-plugins/i18n-importer.mjs';
import { pluginVirtualModuleGenerator } from './vite-plugins/plugin-importer.mjs';
import pluginLoader from './vite-plugins/plugin-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const resolveAlias = {
  '@': resolve(__dirname, './src'),
  '@assets': resolve(__dirname, './assets'),
};

// electron-vite and Vite take their builtin lists from the runtime running the
// build. Bun counts ws and undici as builtins, so a Bun build would leave them
// out of the bundle. Use Node's list instead.
const nodeBuiltins = [...builtinModules, /^node:/];
const bunBuiltinPackages = new Set(['undici', 'ws']);
const bundleBunBuiltinPackages = (): Plugin => ({
  name: 'bundle-bun-builtin-packages',
  // Runs after electron-vite adds its builtin list to `external`.
  enforce: 'post',
  config(config) {
    const options = config.build?.rolldownOptions;
    if (options && Array.isArray(options.external)) {
      options.external = options.external.filter(
        (id) => typeof id !== 'string' || !bunBuiltinPackages.has(id),
      );
    }
  },
});

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  const mainAndPreloadExcludes = ['electron', 'custom-electron-prompt', ...builtinModules];
  const mainConfig: MainViteConfig = {
    plugins: [
      bundleBunBuiltinPackages(),
      pluginLoader('backend'),
      viteResolve({
        'virtual:i18n': i18nImporter(),
        'virtual:plugins': pluginVirtualModuleGenerator('main'),
      }),
    ],
    publicDir: 'assets',
    define: {
      __dirname: 'import.meta.dirname',
      __filename: 'import.meta.filename',
    },
    build: {
      lib: {
        entry: 'src/index.ts',
        formats: ['es'],
      },
      outDir: 'dist/main',
      rolldownOptions: {
        external: mainAndPreloadExcludes,
        input: './src/index.ts',
        output: {
          comments: {
            jsdoc: true,
            annotation: false,
            legal: true,
          },
        },
      },
      minify: !isDev,
      cssMinify: !isDev,
      sourcemap: isDev ? 'inline' : undefined,
      externalizeDeps: false,
    },
    resolve: {
      alias: resolveAlias,
      builtins: nodeBuiltins,
    },
  };

  const preloadConfig: PreloadViteConfig = {
    plugins: [
      bundleBunBuiltinPackages(),
      pluginLoader('preload'),
      viteResolve({
        'virtual:i18n': i18nImporter(),
        'virtual:plugins': pluginVirtualModuleGenerator('preload'),
      }),
    ],
    build: {
      lib: {
        entry: 'src/preload.ts',
        formats: ['cjs'],
      },
      outDir: 'dist/preload',
      commonjsOptions: {
        ignoreDynamicRequires: true,
      },
      rolldownOptions: {
        external: mainAndPreloadExcludes,
        input: './src/preload.ts',
      },
      minify: !isDev,
      cssMinify: !isDev,
      sourcemap: isDev ? 'inline' : undefined,
      externalizeDeps: false,
    },
    resolve: {
      alias: resolveAlias,
      builtins: nodeBuiltins,
    },
  };

  const rendererExcludes = ['electron', ...builtinModules];
  const rendererConfig: RendererViteConfig = {
    plugins: [
      pluginLoader('renderer'),
      viteResolve({
        'virtual:i18n': i18nImporter(),
        'virtual:plugins': pluginVirtualModuleGenerator('renderer'),
      }),
      withFilter(solidPlugin(), {
        load: { id: [/\.(tsx|jsx)$/, '/@solid-refresh'] },
      }),
    ],
    root: './src/',
    build: {
      lib: {
        entry: 'src/index.html',
        formats: ['iife'],
        name: 'renderer',
      },
      outDir: 'dist/renderer',
      rolldownOptions: {
        external: rendererExcludes,
        input: './src/index.html',
      },
      minify: !isDev,
      cssMinify: !isDev,
      sourcemap: isDev ? 'inline' : undefined,
    },
    resolve: {
      alias: resolveAlias,
    },
    server: {
      cors: {
        origin: 'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com',
      },
    },
  };

  if (isDev) {
    mainConfig.plugins?.push(
      Inspect({
        build: true,
        outputDir: join(__dirname, '.vite-inspect/backend'),
      }),
    );
    preloadConfig.plugins?.push(
      Inspect({
        build: true,
        outputDir: join(__dirname, '.vite-inspect/preload'),
      }),
    );
    rendererConfig.plugins?.push(
      Inspect({
        build: true,
        outputDir: join(__dirname, '.vite-inspect/renderer'),
      }),
    );
  }

  return {
    main: mainConfig,
    preload: preloadConfig,
    renderer: rendererConfig,
  };
});
