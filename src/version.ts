import { createRequire } from "node:module";

/**
 * Package version, read from package.json at runtime. Declared once because
 * the relative path resolves against the build output layout, and two copies
 * would drift the moment that layout changed.
 */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
