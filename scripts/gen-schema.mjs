// Embeds db/schema.sql in a module so the hosted setup route can run it (serverless functions can't rely on reading repo files).
import { readFileSync, writeFileSync } from "node:fs";
const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
writeFileSync(new URL("../lib/schema.generated.mjs", import.meta.url),
  `// Generated from db/schema.sql by scripts/gen-schema.mjs. Do not edit.\nexport default ${JSON.stringify(sql)};\n`);
console.log("schema embedded:", sql.length, "chars");
