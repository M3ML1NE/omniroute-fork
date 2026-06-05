const fs = require('fs');
const file = '/root/omniroute-fork/src/app/(dashboard)/dashboard/providers/page.tsx';
let content = fs.readFileSync(file, 'utf8');

const lines = content.split('\n');
const newLines = [];

let skip = false;
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (line.match(/^\s*\{\/\* .* \*\/\}\s*$/) && lines[i+1] && lines[i+1].includes('{showSection(')) {
    const section = lines[i+1].match(/showSection\("([^"]+)"\)/)[1];
    if (section !== 'apikey' && section !== 'compatible') {
      skip = true;
      braceCount = 0;
      continue;
    } else if (section === 'apikey' && lines[i+1].includes('Entries.length > 0')) {
      skip = true;
      braceCount = 0;
      continue;
    }
  }

  if (!skip && line.includes('{showSection(') && !line.includes('//')) {
    const section = line.match(/showSection\("([^"]+)"\)/)[1];
    if (section !== 'apikey' && section !== 'compatible') {
      skip = true;
      braceCount = 0;
    } else if (section === 'apikey' && line.includes('Entries.length > 0')) {
      skip = true;
      braceCount = 0;
    }
  }

  if (skip) {
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    braceCount += openBraces - closeBraces;
    
    if (braceCount <= 0 && line.trim() === ')}') {
      skip = false;
    }
  } else {
    newLines.push(line);
  }
}

fs.writeFileSync(file, newLines.join('\n'));
console.log('Done');
