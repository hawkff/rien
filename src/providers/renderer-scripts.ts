import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

export interface RendererScript {
  file: string;
  url: string;
  code: string;
}

const rendererPath = path.join(import.meta.dirname, '..', 'renderer');
const pluginEntry = /^plugins\/([^/]+?)(?:\/index)?\.[jt]sx?$/;
let manifest: Manifest | undefined;

const readManifest = () =>
  (manifest ??= JSON.parse(
    fs.readFileSync(path.join(rendererPath, '.vite', 'manifest.json'), 'utf8'),
  ) as Manifest);

// The chunk files of `start` and of everything it imports, minus `skip`.
// Dynamic imports of plugins are followed only for the plugins in `plugins`.
export const collectChunks = (
  chunks: Manifest,
  start: string,
  plugins: Set<string>,
  skip = new Set<string>(),
) => {
  const files = new Set<string>();
  const visit = (key: string) => {
    const chunk = chunks[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    chunk.imports?.forEach(visit);
    for (const imported of chunk.dynamicImports ?? []) {
      const plugin = pluginEntry.exec(imported)?.[1];
      if (plugin === undefined || plugins.has(plugin)) visit(imported);
    }
  };
  visit(start);
  return [...files].filter((file) => file.endsWith('.cjs') && !skip.has(file));
};

const toScripts = (files: string[]) =>
  files.map((file): RendererScript => ({
    file,
    url: url.pathToFileURL(path.join(rendererPath, file)).toString(),
    code: fs.readFileSync(path.join(rendererPath, file), 'utf8'),
  }));

// The page script is split into chunks, and only the chunks of enabled
// plugins are injected, so the code of disabled plugins never reaches the page.
export const getRendererScripts = (plugins: string[]) => {
  const chunks = readManifest();
  const entry = Object.keys(chunks).find((key) => chunks[key].isEntry)!;
  return {
    entry: chunks[entry].file,
    scripts: toScripts(collectChunks(chunks, entry, new Set(plugins))),
  };
};

export const getRendererPluginScripts = (id: string, loaded: string[]) => {
  const chunks = readManifest();
  const key = Object.keys(chunks).find(
    (name) => pluginEntry.exec(name)?.[1] === id,
  );
  return key
    ? toScripts(collectChunks(chunks, key, new Set([id]), new Set(loaded)))
    : [];
};
