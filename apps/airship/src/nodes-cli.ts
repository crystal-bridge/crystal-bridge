import { addNode, loadNodes } from './nodes.js';

// Usage: node:add <node-id> | node:list   (reads AIRSHIP_NODES, default ./nodes.json)
const path = process.env.AIRSHIP_NODES ?? './nodes.json';
const [command, node] = process.argv.slice(2);

if (command === 'add' && node) {
  const token = addNode(path, node);
  console.log(`Token for node "${node}" (shown once; set it as CRYSTAL_TOKEN on that node):\n\n${token}\n`);
  console.log(`Stored its hash in ${path}. Restart the Airship to pick it up.`);
} else if (command === 'list') {
  for (const id of loadNodes(path).ids()) console.log(id);
} else {
  console.error('usage: node:add <node-id> | node:list');
  process.exit(2);
}
