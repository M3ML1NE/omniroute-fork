const fs = require('fs');
const path = '/root/omniroute-fork/src/i18n/messages/ru.json';
let content = fs.readFileSync(path, 'utf8');

// The easiest way is to just replace "__MISSING__:" with ""
// That way the UI at least falls back to English strings cleanly, without the ugly prefix.
content = content.replace(/\"__MISSING__:/g, '"');

fs.writeFileSync(path, content);
console.log('Done stripping __MISSING__');
