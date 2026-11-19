#!/usr/bin/env bash
# Build the PI Lab phone app's release APK locally (no Expo hosted services):
# `expo prebuild` makes android/, Gradle builds the release variant with the
# JavaScript bundle inside (no Metro needed), signed with the debug key, for
# arm64 phones and the arm64 emulator. The APK is copied to build-output/.
#
# Usage: apps/mobile/scripts/build-android.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
npm ci
CI=1 npx expo prebuild --platform android --no-install --clean
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)
mkdir -p build-output
cp android/app/build/outputs/apk/release/app-release.apk build-output/pi-lab-mobile.apk
echo "APK: $(pwd)/build-output/pi-lab-mobile.apk"
