#!/usr/bin/env bash
# Installs the jstyle skill with `npx skills add -g` and links the `jstyle`
# command to the installed skill, so the skill and the command are one copy.
set -euo pipefail

REPO="x-mesh/jstyle"
SKILL_DIR="$HOME/.agents/skills/jstyle"
BIN_DIR="${JSTYLE_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE=22

usage() {
  cat <<EOF
usage: install.sh [--help]

PATH에 있는 에이전트(claude, codex)에 jstyle 스킬을 설치하고,
jstyle 명령을 \$JSTYLE_BIN_DIR(기본값 ~/.local/bin)에 연결합니다.
다시 실행하면 최신 버전으로 업데이트합니다.
EOF
}

die() {
  printf '✗ %s\n' "$1" >&2
  exit 1
}

case "${1:-}" in
  "") ;;
  -h | --help) usage; exit 0 ;;
  *) printf '✗ 알 수 없는 옵션: %s\n' "$1" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || die "Node.js $MIN_NODE 이상이 필요합니다"
command -v npx >/dev/null 2>&1 || die "npx가 필요합니다"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge "$MIN_NODE" ] || die "Node.js $MIN_NODE 이상이 필요합니다 (현재 $(node -v))"

# Piped through `curl | bash`, BASH_SOURCE names no file, so install from GitHub.
source="$REPO"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || true)"
if [ -n "$script_dir" ] && [ -f "$script_dir/SKILL.md" ] && grep -q '^name: jstyle$' "$script_dir/SKILL.md"; then
  source="$script_dir"
fi

agents=()
command -v claude >/dev/null 2>&1 && agents+=(claude-code)
command -v codex >/dev/null 2>&1 && agents+=(codex)
[ "${#agents[@]}" -gt 0 ] || die "PATH에 claude나 codex가 없습니다. 다른 에이전트는 npx skills add $REPO -g 로 설치하세요"

link="$BIN_DIR/jstyle"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  die "$link에 다른 파일이 있습니다. 지운 뒤 다시 실행하세요"
fi

if [ -f "$SKILL_DIR/package.json" ]; then
  printf '스킬 업데이트: jstyle %s ← %s\n' "$(node -p "require('$SKILL_DIR/package.json').version")" "$source"
else
  printf '스킬 설치: %s\n' "$source"
fi
# Under `curl | bash` the script itself is stdin; npx would swallow the rest of it.
npx -y skills add "$source" -g -s jstyle -a "${agents[@]}" -y </dev/null
[ -x "$SKILL_DIR/bin/jstyle.mjs" ] || die "스킬 설치 후 $SKILL_DIR/bin/jstyle.mjs가 없습니다"

mkdir -p "$BIN_DIR"
ln -sfn "$SKILL_DIR/bin/jstyle.mjs" "$link"
printf '명령 연결: %s → %s\n' "$link" "$SKILL_DIR/bin/jstyle.mjs"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '! %s를 PATH에 추가해야 jstyle을 실행할 수 있습니다\n' "$BIN_DIR" ;;
esac
found="$(command -v jstyle || true)"
if [ -n "$found" ] && [ "$found" != "$link" ]; then
  printf '! PATH에서 %s가 먼저 잡힙니다. 지우지 않으면 새로 연결한 명령이 가려집니다\n' "$found"
fi

"$link" doctor
printf '완료. 새 에이전트 세션에서 스킬을 불러옵니다.\n'
