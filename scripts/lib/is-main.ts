// True when the module with this `import.meta.url` is the script node was started with.
// pathToFileURL percent-encodes the path the way import.meta.url does, so a checkout under a
// directory with spaces (or other URL-unsafe characters) still runs its scripts.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  // Node resolves symlinks for the entry module (macOS /tmp is /private/tmp) but argv[1] keeps them.
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // argv[1] is not a file on disk (e.g. a REPL or `node -e`): this module is not the entry point.
    return false;
  }
}
