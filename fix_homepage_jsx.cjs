const fs = require('fs');
const file = '/root/omniroute-fork/src/app/(dashboard)/dashboard/HomePageClient.tsx';
let content = fs.readFileSync(file, 'utf8');

// Find the block: {versionInfo?.updateAvailable && !showUpdateOverlay && (
// And remove it
const startStr = '{versionInfo?.updateAvailable && !showUpdateOverlay && (';
const startIndex = content.indexOf(startStr);
if (startIndex !== -1) {
  let braceCount = 0;
  let parenCount = 0;
  let endIndex = -1;
  let foundStart = false;
  
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') braceCount--;
    if (content[i] === '(') parenCount++;
    if (content[i] === ')') parenCount--;
    
    if (!foundStart && braceCount > 0 && parenCount > 0) {
      foundStart = true;
    }
    
    if (foundStart && braceCount === 0 && parenCount === 0 && content[i] === '}') {
      endIndex = i + 1;
      break;
    }
  }
  
  if (endIndex !== -1) {
    content = content.substring(0, startIndex) + content.substring(endIndex);
    console.log('Removed update Available banner');
  }
}

// Remove the Overlay
const startOverlayStr = '{showUpdateOverlay && (';
const startOverlayIndex = content.indexOf(startOverlayStr);
if (startOverlayIndex !== -1) {
  let braceCount = 0;
  let parenCount = 0;
  let endIndex = -1;
  let foundStart = false;
  
  for (let i = startOverlayIndex; i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') braceCount--;
    if (content[i] === '(') parenCount++;
    if (content[i] === ')') parenCount--;
    
    if (!foundStart && braceCount > 0 && parenCount > 0) {
      foundStart = true;
    }
    
    if (foundStart && braceCount === 0 && parenCount === 0 && content[i] === '}') {
      endIndex = i + 1;
      break;
    }
  }
  
  if (endIndex !== -1) {
    content = content.substring(0, startOverlayIndex) + content.substring(endIndex);
    console.log('Removed Update Overlay banner');
  }
}

fs.writeFileSync(file, content);
