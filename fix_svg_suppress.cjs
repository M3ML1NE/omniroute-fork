const fs = require('fs');
const file = '/root/omniroute-fork/src/shared/components/OmniRouteLogo.tsx';
let content = fs.readFileSync(file, 'utf8');

// Add suppressHydrationWarning to the SVG to prevent Dark Reader errors
content = content.replace(/<svg/, '<svg suppressHydrationWarning');

fs.writeFileSync(file, content);
console.log('Added suppressHydrationWarning to OmniRouteLogo');
