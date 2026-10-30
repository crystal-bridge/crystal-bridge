import { addNode, loadNodes } from './nodes.js';

// Usage: token:add <name> | token:list | token:remove <name>   (reads AIRSHIP_TOKENS, default ./access-tokens.json)
const path = process.env.AIRSHIP_TOKENS ?? './access-tokens.json';
const [command, name] = process.argv.slice(2);

if (command === 'add' && name) {
  console.log(`Access token "${name}" (shown once; paste it into the login page):\n\n${addNode(path, name)}\n`);
} else if (command === 'list') {
  for (const id of loadNodes(path).ids()) console.log(id);
} else if (command === 'remove' && name) {
  console.log(loadNodes(path).revoke(name) ? `Removed "${name}".` : `No token named "${name}".`);
} else {
  console.error('usage: token:add <name> | token:list | token:remove <name>');
  process.exit(2);
}
