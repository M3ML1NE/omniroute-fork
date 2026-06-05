const fs = require('fs');
const file = '/root/omniroute-fork/src/shared/components/Breadcrumbs.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/<nav/, '<nav suppressHydrationWarning');

fs.writeFileSync(file, content);
console.log('Added suppressHydrationWarning to Breadcrumbs');
