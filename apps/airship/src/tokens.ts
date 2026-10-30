import { addNode, loadNodes } from './nodes.js';

/** `token add <name>`, `token list` and `token remove <name>` against the access-token file. */
export function runTokens(path: string, [command, name]: readonly string[]): void {
  if (command === 'add' && name) {
    console.log(`Access token "${name}" (shown once; paste it into the login page):\n\n${addNode(path, name)}\n`);
  } else if (command === 'list') {
    for (const id of loadNodes(path).ids()) console.log(id);
  } else if (command === 'remove' && name) {
    console.log(loadNodes(path).revoke(name) ? `Removed "${name}".` : `No token named "${name}".`);
  } else {
    console.error('usage: token add <name> | token list | token remove <name>');
    process.exit(2);
  }
}
