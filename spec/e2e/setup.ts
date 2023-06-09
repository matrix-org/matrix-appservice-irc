import * as fs from "node:fs/promises";

export default async function() {
    console.log('Cleaning .e2e-traces')
    await fs.rm('.e2e-traces', { recursive: true, force: true })
    await fs.mkdir('.e2e-traces');
}

