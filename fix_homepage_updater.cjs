const fs = require('fs');
const file = '/root/omniroute-fork/src/app/(dashboard)/dashboard/HomePageClient.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Remove window.electronAPI.checkForUpdates() block (lines 176-178 roughly)
content = content.replace(/window\.electronAPI\.checkForUpdates\(\)\.catch\(\(err:\s*any\)\s*=>\s*\{\s*console\.error\(\"\[Electron\]\s*Check\s*for\s*updates\s*failed:\",\s*err\);\s*\}\);/g, '');

// 2. Remove window.electronAPI?.checkForUpdates() near the bottom
content = content.replace(/window\.electronAPI\?\.checkForUpdates\(\)\.catch\(\(err:\s*any\)\s*=>\s*\{\s*console\.error\(\"\[Electron\]\s*Check\s*for\s*updates\s*failed:\",\s*err\);\s*\}\);/g, '');

// 3. Optional: we can just remove the whole update section from the UI
content = content.replace(/\{updateSteps.*?\{updateSteps\.find\(\(s\)\s*=>\s*s\.step\s*===\s*"complete"\)\?\.message\s*\|\|\s*"Update\s*complete!"\}/s, '{/* Update UI removed */}');

// Just to be safe, since it's a JSX file, we can also remove the 'update available' banners entirely.
// Or we can just leave it as is if it doesn't crash.

fs.writeFileSync(file, content);
console.log('Removed updater checks');
