/**
 * Renders the multi-size .ico for the Windows executable (M4).
 *
 * Taskbar and Explorer read the icon embedded in the exe resource, and Windows
 * wants a multi-image .ico (16..256px). The images are drawn at each size from
 * the same geometry as the PNG (icon-art.mjs), not downscaled, so the 16px
 * entry Explorer uses in list view keeps the stroke instead of aliasing it
 * away.
 *
 * PNG-compressed entries are Vista+ format: the smallest possible container
 * for this many sizes, and the format resedit expects.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIco, ICO_SIZES_EXPORTED } from "./icon-art.mjs";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(webRoot, "resources", "app", "icon.ico");
writeFileSync(outFile, encodeIco());
console.log("icon.ico written: " + ICO_SIZES_EXPORTED.length + " sizes, " + ICO_SIZES_EXPORTED.join(", "));
