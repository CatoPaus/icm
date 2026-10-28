import * as fs from 'fs';
import * as path from 'path';

const dirsToRemove = [
  path.resolve('.sessions'),
  path.resolve('.snapshots'),
  path.resolve('.icm'),
  path.resolve('workspace/runs'),
  path.resolve('workspace/stages/01_research/output'),
  path.resolve('workspace/stages/02_script/output')
];

console.log('Starting workspace cleanup...');

for (const dir of dirsToRemove) {
  if (fs.existsSync(dir)) {
    console.log(`Removing directory: ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('Cleanup completed successfully!');
