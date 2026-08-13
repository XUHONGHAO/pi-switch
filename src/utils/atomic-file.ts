import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";

/** Replace a file with a prepared temp file, including a Windows-safe fallback. */
export function replaceFile(temp: string, destination: string): void {
  try {
    renameSync(temp, destination);
  } catch (err) {
    // Windows rename may reject replacing an existing file. Preserve the old
    // destination until the prepared temp has been fully written.
    const old = `${destination}.${process.pid}.${Date.now()}.old`;
    try {
      if (existsSync(destination)) renameSync(destination, old);
      renameSync(temp, destination);
      if (existsSync(old)) rmSync(old, { force: true });
    } catch (fallbackError) {
      if (!existsSync(destination) && existsSync(old)) {
        try { renameSync(old, destination); } catch { copyFileSync(old, destination); }
      }
      throw fallbackError instanceof Error ? fallbackError : err;
    } finally {
      if (existsSync(old) && existsSync(destination)) rmSync(old, { force: true });
    }
  }
}
