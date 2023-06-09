import fs from "node:fs";

fs.rmSync('.e2e-traces', { recursive: true, force: true })
fs.mkdirSync('.e2e-traces');
