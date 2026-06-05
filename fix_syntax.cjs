const fs = require('fs');
const file = '/root/omniroute-fork/src/app/(dashboard)/dashboard/HomePageClient.tsx';
let content = fs.readFileSync(file, 'utf8');

// The lines 816 and 817 look like:
//         </div>
//       )}
// Let's replace them precisely
content = content.replace(/\s*<\/div>\n\s*\)\}\n\s*\{\/\* Pinned Provider Quota Limits/g, '\n\n      {/* Pinned Provider Quota Limits');

fs.writeFileSync(file, content);
console.log('Fixed stray tags');
