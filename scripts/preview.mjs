import path from "node:path";

process.env.SKILL_DESIGNER_DATA_DIR ??= path.resolve(".skill-designer-dev");
process.env.SKILL_DESIGNER_PORT ??= "4310";

await import("../packages/server/dist/index.js");
