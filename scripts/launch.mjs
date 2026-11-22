// Shared by the double-click launchers (play-mac.command, play-windows.bat):
// install packages when needed — first run, or package-lock.json changed by an
// update — then `npm run play`. Lives in Node rather than in the launchers
// because cmd.exe garbles Korean text in batch files.
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const win = process.platform === 'win32';
// Windows needs a shell to run npm.cmd (Node refuses .cmd files without one);
// the arguments are fixed literals, so one command string is safe there.
const npm = (args) =>
  (win
    ? spawnSync(`npm.cmd ${args.join(' ')}`, { stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { stdio: 'inherit' })
  ).status ?? 1;

let needInstall = true;
try {
  needInstall =
    statSync('package-lock.json').mtimeMs > statSync('node_modules/.package-lock.json').mtimeMs;
} catch { /* never installed */ }

if (needInstall) {
  console.log('• 처음 준비 중이에요. 1~2분 걸리고 인터넷이 필요해요…');
  if (npm(['install']) !== 0) {
    console.error('✗ 설치에 실패했어요. 인터넷 연결을 확인하고 다시 실행해 주세요.');
    process.exit(1);
  }
}
process.exit(npm(['run', 'play']));
