// Reverting the manual fixes since they broke things by adding `await` in sync functions
require('child_process').execSync('git checkout src/lib/db/');
console.log('Reverted db directory to last commit state.');
