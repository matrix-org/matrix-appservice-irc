import fs from "node:fs";

console.log('Cleaning .e2e-traces')
fs.rmSync('.e2e-traces', { recursive: true, force: true })
fs.mkdirSync('.e2e-traces');
