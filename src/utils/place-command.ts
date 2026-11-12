import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Puts the command at `target`: a link to the app's own binary, which then
 * updates with the app, or a copy where the app's files live in a mount that
 * goes away when it quits (AppImage).
 */
export const placeCommand = (binary: string, target: string, copy: boolean) => {
  mkdirSync(path.dirname(target), { recursive: true });
  // Made beside it and renamed over it, so a failed install keeps the old one
  const partial = `${target}.${process.pid}.partial`;
  rmSync(partial, { force: true });
  try {
    if (copy) {
      copyFileSync(binary, partial);
      chmodSync(partial, 0o755);
    } else {
      symlinkSync(binary, partial);
    }
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
};
