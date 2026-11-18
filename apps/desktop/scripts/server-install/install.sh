#!/bin/sh
# PI Lab server installer (macOS). Installs the server bundle for machines that
# run PI Lab without the desktop app, and starts it as a per-user launchd agent.
#
#   install.sh [--version <v>] [--from-file <tar.gz>] [--data-dir <dir>]
#              [--prefix <dir>] [--label <launchd label>] [--no-launchd]
#
#   --version     the release to download from GitHub (default: the latest Stable release)
#   --from-file   install this bundle instead of downloading; its SHA-256 is checked
#                 against the `.sha256` file next to it
#   --data-dir    PI Lab's data folder (default: $HOME/.pi-lab)
#   --prefix      where the server program goes (default: $HOME/.pi-lab/server)
#   --label       launchd label (default: com.pi-lab.server)
#   --no-launchd  start the server as a detached process instead (tests)
#
# Layout: <prefix>/versions/<version>/ (unpacked bundles: the current and the
# previous version are kept), <prefix>/current and <prefix>/previous (symlinks),
# <prefix>/failed-versions (versions that did not start, one per line).
#
# The new server must write `server.json` within PI_LAB_INSTALL_START_TIMEOUT
# seconds (default 120). If it does not, the previous version is put back,
# with the database copy the new server made before its migrations
# (`local.db.pre-<build>`), and the installer exits 1.
#
# Exit codes: 0 installed and listening; 1 failed; 2 usage; 3 a PI Lab desktop
# app server already serves the data folder (PI Lab uses that server).
set -eu

RELEASES="https://github.com/enajx/PI-Lab/releases"
DEFAULT_LABEL="com.pi-lab.server"

version=""
from_file=""
data_dir="$HOME/.pi-lab"
prefix="$HOME/.pi-lab/server"
label="$DEFAULT_LABEL"
use_launchd=1
start_timeout="${PI_LAB_INSTALL_START_TIMEOUT:-120}"

say() { echo "pi-lab install: $*" >&2; }
die() {
  say "$*"
  exit 1
}
usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version | --from-file | --data-dir | --prefix | --label)
      [ $# -ge 2 ] || {
        say "$1 needs a value"
        usage
      }
      case "$1" in
        --version) version=$2 ;;
        --from-file) from_file=$2 ;;
        --data-dir) data_dir=$2 ;;
        --prefix) prefix=$2 ;;
        --label) label=$2 ;;
      esac
      shift 2
      ;;
    --no-launchd)
      use_launchd=0
      shift
      ;;
    -h | --help) usage ;;
    *)
      say "unknown option $1"
      usage
      ;;
  esac
done

system=$(uname -s)
case "$system" in
  Darwin) ;;
  Linux) die "Linux comes in step 3 of multi-machine PI Lab; only macOS is supported for now" ;;
  *) die "$system is not supported; only macOS is" ;;
esac
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) die "unsupported processor $(uname -m)" ;;
esac

absolute() {
  case "$1" in
    /*) printf '%s' "${1%/}" ;;
    *) printf '%s/%s' "$PWD" "${1%/}" ;;
  esac
}
prefix=$(absolute "$prefix")
data_dir=$(absolute "$data_dir")

# Tests must never touch the real install, data folder or launchd agent.
if [ "${PI_LAB_TEST_MODE:-}" = "1" ]; then
  [ "$use_launchd" = 0 ] || [ "$label" != "$DEFAULT_LABEL" ] ||
    die "test mode needs --no-launchd or a test --label"
  [ "$prefix" != "$HOME/.pi-lab/server" ] && [ "$data_dir" != "$HOME/.pi-lab" ] ||
    die "test mode needs --prefix and --data-dir"
fi

mkdir -p "$prefix/versions" "$data_dir"
prefix=$(cd "$prefix" && pwd -P)
data_dir=$(cd "$data_dir" && pwd -P)

work=$(mktemp -d "$prefix/.install.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 1. The bundle and its SHA-256.
if [ -n "$from_file" ]; then
  [ -f "$from_file" ] || die "no file $from_file"
  tarball=$from_file
  sum_file="$from_file.sha256"
  [ -f "$sum_file" ] || die "no $sum_file next to the bundle"
else
  if [ -z "$version" ]; then
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES/latest") ||
      die "could not find the latest release"
    version=${latest##*/v}
  fi
  name="pi-lab-server-$version-darwin-$arch.tar.gz"
  say "downloading $name"
  tarball="$work/$name"
  sum_file="$tarball.sha256"
  curl -fsSL -o "$tarball" "$RELEASES/download/v$version/$name" || die "download of $name failed"
  curl -fsSL -o "$sum_file" "$RELEASES/download/v$version/$name.sha256" ||
    die "download of $name.sha256 failed"
fi
expected=$(awk 'NR == 1 { print $1 }' "$sum_file")
actual=$(shasum -a 256 "$tarball" | awk '{ print $1 }')
case "$expected" in
  [0-9a-f]*) [ ${#expected} -eq 64 ] || die "$sum_file holds no SHA-256 sum" ;;
  *) die "$sum_file holds no SHA-256 sum" ;;
esac
[ "$actual" = "$expected" ] || die "SHA-256 of $tarball is $actual, expected $expected"

# 2. Unpack and read the bundle's identity.
mkdir "$work/unpacked"
tar -xzf "$tarball" -C "$work/unpacked"
set -- "$work"/unpacked/pi-lab-server-*
[ $# -eq 1 ] && [ -f "$1/bundle.json" ] || die "$tarball is not a PI Lab server bundle"
bundle=$1
json_field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$2" | head -n 1; }
new_version=$(json_field version "$bundle/bundle.json")
new_build=$(json_field build "$bundle/bundle.json")
bundle_arch=$(json_field arch "$bundle/bundle.json")
[ -n "$new_version" ] && [ -n "$new_build" ] || die "$bundle/bundle.json is incomplete"
[ -z "$version" ] || [ "$version" = "$new_version" ] ||
  die "the bundle holds version $new_version, not $version"
[ "$bundle_arch" = "$arch" ] || die "the bundle is for $bundle_arch, this Mac is $arch"

# 3. The server that runs on this data folder now.
discovery="$data_dir/server.json"
server_pid() {
  [ -f "$discovery" ] || return 0
  sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$discovery" | head -n 1
}
server_build() {
  [ -f "$discovery" ] || return 0
  json_field build "$discovery"
}
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
old_pid=""
pid=$(server_pid)
if alive "$pid"; then
  command=$(ps -p "$pid" -o command= || true)
  case "$command" in
    "$prefix"/versions/*) old_pid=$pid ;;
    */out/main/server.js*)
      say "a PI Lab app server (pid $pid) already serves $data_dir; PI Lab uses that server"
      exit 3
      ;;
  esac
fi

uid=$(id -u)
plist="$HOME/Library/LaunchAgents/$label.plist"

# The pid in server.json when it is a server of this install (never another process).
our_server_pid() {
  candidate=$(server_pid)
  alive "$candidate" || return 0
  case "$(ps -p "$candidate" -o command= || true)" in
    "$prefix"/versions/*) echo "$candidate" ;;
  esac
}

# Stop the launchd agent (launchd mode) and the server process $1, or this install's server.
stop_server() {
  if [ "$use_launchd" = 1 ]; then
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  fi
  stop_pid=$1
  if [ -z "$stop_pid" ]; then stop_pid=$(our_server_pid); fi
  alive "$stop_pid" || return 0
  kill -TERM "$stop_pid" 2>/dev/null || true
  waited=0
  while alive "$stop_pid" && [ $waited -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if alive "$stop_pid"; then kill -KILL "$stop_pid" 2>/dev/null || true; fi
}

# Replace a symlink in one rename, so `current` always names a version.
set_link() {
  ln -s "$2" "$prefix/$1.new"
  "$prefix/versions/$new_version/node/bin/node" -e \
    'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
    "$prefix/$1.new" "$prefix/$1"
}

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

start_server() {
  rm -f "$data_dir/server-error.json"
  launcher="$prefix/current/bin/pi-lab-server"
  if [ "$use_launchd" = 1 ]; then
    mkdir -p "$(dirname "$plist")"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$launcher")</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_LAB_DATA_DIR</key><string>$(xml "$data_dir")</string>
    <key>PI_LAB_SERVER_LABEL</key><string>$(xml "$label")</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
    <key>SHELL</key><string>$(xml "${SHELL:-/bin/zsh}")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$data_dir/server.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$data_dir/server.log")</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$uid" "$plist" || die "launchctl bootstrap of $plist failed"
    started_pid=""
  else
    PI_LAB_DATA_DIR="$data_dir" PI_LAB_SERVER_LABEL="" \
      nohup "$launcher" serve >>"$data_dir/server.log" 2>&1 </dev/null &
    started_pid=$!
  fi
}

# Wait until a server of build $1 (not $old_pid) lists itself in server.json.
wait_for_server() {
  deadline=$(($(date +%s) + start_timeout))
  while [ "$(date +%s)" -le "$deadline" ]; do
    if [ -s "$data_dir/server-error.json" ]; then
      say "the server reported: $(cat "$data_dir/server-error.json")"
      return 1
    fi
    pid=$(server_pid)
    if [ "$pid" != "$old_pid" ] && alive "$pid" && [ "$(server_build)" = "$1" ]; then
      return 0
    fi
    if [ -n "$started_pid" ] && ! alive "$started_pid"; then
      say "the server exited while starting; see $data_dir/server.log"
      return 1
    fi
    sleep 0.2
  done
  say "the server did not start within $start_timeout s; see $data_dir/server.log"
  return 1
}

# 4. Put the new version in place and switch `current`.
previous_target=""
if [ -L "$prefix/current" ]; then previous_target=$(readlink "$prefix/current"); fi
stop_server "$old_pid"
old_pid=""
rm -rf "$prefix/versions/$new_version"
mv "$bundle" "$prefix/versions/$new_version"
set_link current "versions/$new_version"
if [ -n "$previous_target" ] && [ "$previous_target" != "versions/$new_version" ]; then
  set_link previous "$previous_target"
fi

# 5. Start it, or roll back to the previous version.
start_server
if ! wait_for_server "$new_build"; then
  echo "$new_version" >>"$prefix/failed-versions"
  if [ -z "$previous_target" ] || [ "$previous_target" = "versions/$new_version" ] ||
    [ ! -d "$prefix/$previous_target" ]; then
    stop_server "$started_pid"
    die "version $new_version did not start and there is no previous version to go back to"
  fi
  say "version $new_version did not start; going back to $previous_target"
  stop_server "$started_pid"
  copy="$data_dir/local.db.pre-$new_build"
  if [ -f "$copy" ]; then
    for suffix in "" -wal -shm; do
      if [ -f "$data_dir/local.db$suffix" ]; then
        mv -f "$data_dir/local.db$suffix" "$data_dir/local.db.failed-$new_build$suffix"
      fi
    done
    cp "$copy" "$data_dir/local.db"
    say "restored the database copied before the migrations of $new_version"
  fi
  set_link current "$previous_target"
  rm -f "$prefix/previous"
  rm -rf "$prefix/versions/$new_version"
  previous_build=$(json_field build "$prefix/$previous_target/bundle.json")
  start_server
  wait_for_server "$previous_build" || die "the previous version did not start either"
  die "version $new_version did not start; $previous_target runs again"
fi

# 6. Keep the current and the previous version only.
keep_previous=""
if [ -L "$prefix/previous" ]; then keep_previous=$(readlink "$prefix/previous"); fi
for dir in "$prefix"/versions/*; do
  [ -d "$dir" ] || continue
  relative="versions/${dir##*/}"
  [ "$relative" = "versions/$new_version" ] || [ "$relative" = "$keep_previous" ] || rm -rf "$dir"
done

say "PI Lab server $new_version runs (pid $(server_pid)), data folder $data_dir"
printf '{"version":"%s","build":"%s","pid":%s}\n' "$new_version" "$new_build" "$(server_pid)"
