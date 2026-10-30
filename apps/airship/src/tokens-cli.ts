import { runTokens } from './tokens.js';

// Usage: token:add <name> | token:list | token:remove <name>   (reads AIRSHIP_TOKENS, default ./access-tokens.json)
runTokens(process.env.AIRSHIP_TOKENS ?? './access-tokens.json', process.argv.slice(2));
