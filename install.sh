#!/usr/bin/env bash
# herdr-changes-review: installer for the Herdr desktop app
#
# Usage:
#   ./install.sh [--home DIR] [--app-bin PATH]
#   ./install.sh --uninstall [--home DIR] [--app-bin PATH]
#
# Options:
#   --home DIR        Herdr configuration directory (default: $HERDR_APP_HOME or ~/.config/herdr-app)
#   --app-bin PATH    Path to herdr-app executable
#   --uninstall       Revert layout back to standard 'changes' mod and remove 'changes-review'
#   -h, --help        Show this help message

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
mod_src="$here/herdr-app/mods/changes-review"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
app_bin="${HERDR_APP_BIN:-}"
mode="install"

say() { echo "herdr-changes-review: $*"; }
die() { echo "herdr-changes-review: error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode="uninstall" ;;
    --home) [ $# -ge 2 ] || die "--home requires a directory"; home="$2"; shift ;;
    --app-bin) [ $# -ge 2 ] || die "--app-bin requires a path"; app_bin="$2"; shift ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

find_app_bin() {
  if [ -n "$app_bin" ]; then echo "$app_bin"; return; fi
  if command -v herdr-app >/dev/null 2>&1; then command -v herdr-app; return; fi
  if [ -x "$HOME/.local/bin/herdr-app" ]; then echo "$HOME/.local/bin/herdr-app"; return; fi
  echo ""
}

HERDR_BIN="$(find_app_bin)"

target_mods="$home/mods"
target_mod="$target_mods/changes-review"
layouts_dir="$home/layouts"

if [ "$mode" = "uninstall" ]; then
  say "Uninstalling changes-review mod..."

  # Revert layouts pointing to changes-review back to changes
  if [ -d "$layouts_dir" ]; then
    for lfile in "$layouts_dir"/*.json; do
      [ -f "$lfile" ] || continue
      if grep -q '"changes-review"' "$lfile" 2>/dev/null; then
        sed -i 's/"mod": *"changes-review"/"mod": "changes"/g' "$lfile"
        say "Reverted $lfile to use default 'changes' mod"
      fi
    done
    if [ -d "$layouts_dir/.state" ]; then
      for sfile in "$layouts_dir/.state"/*.json; do
        [ -f "$sfile" ] || continue
        if grep -q '"changes-review"' "$sfile" 2>/dev/null; then
          sed -i 's/"mod": *"changes-review"/"mod": "changes"/g' "$sfile"
        fi
      done
    fi
  fi

  if [ -d "$target_mod" ]; then
    rm -rf "$target_mod"
    say "Removed $target_mod"
  fi

  say "Uninstallation complete. Reloading layout..."
  if [ -n "$HERDR_BIN" ]; then
    "$HERDR_BIN" do layout.switch '{"name":"main"}' 2>/dev/null || true
  fi
  exit 0
fi

# Mode: install
say "Installing changes-review mod into: $target_mod"

tmp_dir=""
cleanup() {
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

if [ ! -d "$mod_src" ]; then
  say "Fetching herdr-changes-review files from GitHub..."
  tmp_dir="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    curl -fsSL https://github.com/JohnMunozR/herdr-changes-review/archive/refs/heads/main.tar.gz | tar -xz -C "$tmp_dir"
    mod_src="$tmp_dir/herdr-changes-review-main/herdr-app/mods/changes-review"
  elif command -v git >/dev/null 2>&1; then
    git clone --depth 1 https://github.com/JohnMunozR/herdr-changes-review.git "$tmp_dir/repo"
    mod_src="$tmp_dir/repo/herdr-app/mods/changes-review"
  else
    die "Cannot download files: neither curl+tar nor git are available"
  fi
fi

[ -d "$mod_src" ] || die "Mod source directory not found: $mod_src"

mkdir -p "$target_mods"
rm -rf "$target_mod"
cp -r "$mod_src" "$target_mod"

if [ -n "$HERDR_BIN" ]; then
  say "Verifying mod with herdr-app check..."
  "$HERDR_BIN" check "$target_mod" || die "Mod validation failed."
fi

# Ensure personal layout (main-copy.json) exists
mkdir -p "$layouts_dir"
personal_layout="$layouts_dir/main-copy.json"
orig_layout="$layouts_dir/main.json"

if [ ! -f "$personal_layout" ]; then
  if [ -n "$HERDR_BIN" ]; then
    say "Cloning main layout to main-copy..."
    "$HERDR_BIN" do layout.clone '{"name":"main","as":"main-copy"}' 2>/dev/null || true
  fi
  if [ ! -f "$personal_layout" ] && [ -f "$orig_layout" ]; then
    cp "$orig_layout" "$personal_layout"
  fi
fi

if [ -f "$personal_layout" ]; then
  # Configure changes-review in personal layout
  sed -i 's/"mod": *"changes"/"mod": "changes-review"/g' "$personal_layout"
  say "Configured 'changes-review' in $personal_layout"

  if [ -f "$layouts_dir/.state/main-copy.json" ]; then
    sed -i 's/"mod": *"changes"/"mod": "changes-review"/g' "$layouts_dir/.state/main-copy.json"
  fi
fi

if [ -n "$HERDR_BIN" ]; then
  say "Activating personal layout in Herdr..."
  "$HERDR_BIN" do layout.switch '{"name":"main-copy"}' 2>/dev/null || true
  "$HERDR_BIN" do layout.select --stack panel-body --child changes 2>/dev/null || true
  "$HERDR_BIN" do layout.show --id panel 2>/dev/null || true
fi

say "✓ changes-review installed successfully!"
