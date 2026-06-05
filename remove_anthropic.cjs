const fs = require('fs');
const file = '/root/omniroute-fork/open-sse/executors/base.ts';
let content = fs.readFileSync(file, 'utf8');

// Remove import
content = content.replace(/import \{ getClaudeCodeCompatibleRequestDefaults \} from "@\/lib\/providers\/requestDefaults";\n/g, '');

// Clean up isClaudeCodeCompatible references
// We'll replace isClaudeCodeCompatible(provider) with false, or just strip it.
// The easiest is just finding where getClaudeCodeCompatibleRequestDefaults is used.

content = content.replace(/const ccRequestDefaults = isClaudeCodeCompatible\(this\.provider\)\n\s*\? getClaudeCodeCompatibleRequestDefaults\(activeCredentials\?\.providerSpecificData\)\n\s*: \{\};\n/g, '');

content = content.replace(/const shouldForwardCcCompatibleContext1m =\n\s*isClaudeCodeCompatible\(this\.provider\) && ccRequestDefaults\.context1m === true;/g, 'const shouldForwardCcCompatibleContext1m = false;');

fs.writeFileSync(file, content);
console.log('Cleaned up base.ts');
