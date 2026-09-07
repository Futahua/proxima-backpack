import { appendFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [rootArg, operation, relative, destination, value] = process.argv.slice(2);
const root = resolve(rootArg);
const path = (name) => join(root, name);
if (operation === 'write') await writeFile(path(relative), value ?? '', 'utf8');
else if (operation === 'append') await appendFile(path(relative), value ?? '', 'utf8');
else if (operation === 'rename') await rename(path(relative), path(destination));
else if (operation === 'delete') await unlink(path(relative));
else throw new Error(`unknown peer operation: ${operation}`);
