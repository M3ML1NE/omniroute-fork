const fs = require('fs');
const file = '/root/omniroute-fork/src/app/(dashboard)/dashboard/providers/page.tsx';
let content = fs.readFileSync(file, 'utf8');

// The string to keep is API Key and Compatible.
// Let's just remove everything matching \{showSection\("..."\)(.*?\n)*?      \)\}\n
// But wait, there are nested braces. 

// A better way: just slice by lines.
const lines = content.split('\n');
const newLines = [];

let skip = false;
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (line.match(/\{\/\* .* \*\/\}/) && lines[i+1] && lines[i+1].includes('{showSection(')) {
    const section = lines[i+1].match(/showSection\("([^"]+)"\)/)[1];
    if (section !== 'apikey' && section !== 'compatible') {
      skip = true;
      braceCount = 0;
    }
  }

  // Same if there is no comment before it
  if (!skip && line.includes('{showSection(')) {
    const section = line.match(/showSection\("([^"]+)"\)/)[1];
    // However, some apikey sections we want to remove: aggregators, enterprise, embedding, image, video.
    // They look like: {showSection("apikey") && aggregatorProviderEntries.length > 0 && (
    
    if (section !== 'apikey' && section !== 'compatible') {
      skip = true;
      braceCount = 0;
    } else if (section === 'apikey' && line.includes('ProviderEntries.length > 0')) {
      skip = true;
      braceCount = 0;
    }
  }

  if (skip) {
    // Count braces to know when the block ends
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    braceCount += openBraces - closeBraces;
    
    // We expect the block to end when braceCount goes back to 0
    if (braceCount <= 0 && line.trim() === ')}') {
      skip = false;
    }
  } else {
    newLines.push(line);
  }
}

fs.writeFileSync(file, newLines.join('\n'));
console.log('Done');
