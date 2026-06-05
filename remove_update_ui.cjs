const fs = require('fs');
const file = '/root/omniroute-fork/src/app/(dashboard)/dashboard/HomePageClient.tsx';
let content = fs.readFileSync(file, 'utf8');

// The banner starts around line 903: {versionInfo?.updateAvailable && !showUpdateOverlay && (
// And it ends around line 1038 where it says </div>. We can just replace versionInfo?.updateAvailable with false to effectively hide it, but it's cleaner to remove it.
content = content.replace(/\{versionInfo\?\.updateAvailable && !showUpdateOverlay && \([\s\S]*?\{versionInfo\?\.news && \(/g, '{versionInfo?.news && (');

// Also remove the "Check for Updates" button that might exist, or anything else explicitly asking to check for updates.
// The user asked: "нужно выпилить функционал проверки обновления o‍mniroute"
// So we should just remove the fetch call to `/api/system/version` in `fetchData` as well.
content = content.replace(/fetch\("\/api\/system\/version"\)/g, 'Promise.resolve({ ok: true, json: () => Promise.resolve(null) })');

// And we can remove the electronAPI check
content = content.replace(/window\.electronAPI\.checkForUpdates/g, 'Promise.resolve');
content = content.replace(/window\.electronAPI\?\.checkForUpdates/g, 'Promise.resolve');

fs.writeFileSync(file, content);
console.log('Done removing update checks');
