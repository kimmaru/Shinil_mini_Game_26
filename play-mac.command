#!/bin/bash
# 맥에서 Finder로 더블클릭하면 게임이 열립니다.
# 처음 한 번(또는 업데이트 뒤)만 필요한 것을 설치하고, 그다음은 바로 실행해요.
cd "$(dirname "$0")" || exit 1

pause_exit() {
  echo
  read -r -p "엔터를 누르면 창이 닫혀요." _
  exit "$1"
}

# nvm으로 Node를 설치했다면 그것도 찾아요.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 없어요."
  echo "열리는 페이지에서 'Node.js 22 (LTS)' macOS 설치 파일(.pkg)을 받아 설치한 뒤, 이 파일을 다시 더블클릭해 주세요."
  open "https://nodejs.org/ko/download"
  pause_exit 1
fi

# node_modules가 없거나, 업데이트로 package-lock.json이 더 새로우면 설치해요.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "• 처음 준비 중이에요. 1~2분 걸리고 인터넷이 필요해요…"
  npm install || pause_exit 1
fi

npm run play || pause_exit 1
