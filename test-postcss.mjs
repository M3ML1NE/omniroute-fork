import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import fs from 'fs';

const css = fs.readFileSync('src/app/globals.css', 'utf8');

console.log('Running PostCSS...');
postcss([tailwindcss])
  .process(css, { from: 'src/app/globals.css', to: 'dist.css' })
  .then(result => {
    console.log('Success! Length:', result.css.length);
  })
  .catch(err => {
    console.error('Error:', err);
  });
