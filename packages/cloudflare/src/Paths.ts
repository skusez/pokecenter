/** A directory shipped inside this package, as an absolute path. Alchemy
 * resolves relative paths from where the CLI started, which for an installed
 * package is the user's project. Evaluated inside the deployed worker too,
 * where there is no file system and the value is never read. */
const packagePath = (relative: string): string => {
  try {
    return decodeURIComponent(new URL(relative, import.meta.url).pathname)
  } catch {
    return relative
  }
}

export const MIGRATIONS_DIR = packagePath("../migrations")
export const UI_DIR = packagePath("../dist/ui")
