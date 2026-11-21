#!/usr/bin/env node
// Fail fast and legibly on an unsupported Node.
//
// A fresh login shell on this machine defaults to Node 18, which Vite 8 refuses
// outright — and the resulting error is an opaque module-resolution failure that
// costs an agent twenty minutes. This turns it into one line of instructions.
const [maj, min] = process.versions.node.split('.').map(Number);
const ok = (maj === 20 && min >= 19) || maj >= 22;
if (!ok) {
  console.error(`
✗ Node ${process.versions.node} is not supported by this project.
  Vite 8 requires ^20.19.0 or >=22.12.0.

  Fix (this repo pins a version in .nvmrc):
      nvm use
  or:
      nvm use 22
`);
  process.exit(1);
}
