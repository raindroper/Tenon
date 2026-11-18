import { readFile, writeFile } from 'node:fs/promises';

const [serverFile] = process.argv.slice(2);
if (!serverFile) throw new Error('Pass the frozen server/index.ts path.');

const source = await readFile(serverFile, 'utf8');
const original = "app.listen(4317, '127.0.0.1'";
const occurrences = source.split(original).length - 1;
if (occurrences !== 1) {
  throw new Error(`Expected one original loopback listener, found ${occurrences}. Review the frozen release.`);
}

// This listener is inside the Docker bridge. Compose publishes it on the host loopback only.
await writeFile(serverFile, source.replace(original, "app.listen(4317, '0.0.0.0'"));
