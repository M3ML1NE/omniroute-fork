const fs = require('fs');
const file = '/root/omniroute-fork/open-sse/mcp-server/tools/atlassian/bitbucket.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /import \{ BitbucketClient \} from "\.\.\/\.\.\/\.\.\/services\/atlassian\/bitbucketClient\.js";/,
  'import { BitbucketClient } from "../../../services/atlassian/bitbucketClient";'
);
content = content.replace(
  /import \{ getAtlassianConfig \} from "\.\.\/\.\.\/\.\.\/services\/atlassianConfig\.js";/,
  'import { getAtlassianConfig } from "../../../services/atlassianConfig";'
);

fs.writeFileSync(file, content);
console.log('Fixed imports in bitbucket.ts');
