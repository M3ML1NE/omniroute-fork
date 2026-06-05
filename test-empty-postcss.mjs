import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import fs from 'fs';

const css = '@import "tailwindcss";';

console.log('Running PostCSS on empty...');
postcss([tailwindcss])
  .process(css, { from: 'src/app/test.css', to: 'dist.css' })
  .then(result => {
    console.log('Success! Length:', result.css.length);
  })
  .catch(err => {
    console.error('PostCSS error:', err);
  });
