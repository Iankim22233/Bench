#!/bin/sh
# Builds the Forest RT iOS app.
#   ./build.sh        -> build/ForestRT.ipa (unsigned, for Sideloadly / AltStore / re-signing)
#   ./build.sh sim    -> build/sim/.../ForestRT.app for the iOS Simulator
set -eu
cd "$(dirname "$0")"

# bundle the current web build
rm -rf web
mkdir -p web
cp ../index.html web/
cp -R ../js web/

xcodegen generate --quiet

if [ "${1:-}" = "sim" ]; then
  xcodebuild -project ForestRT.xcodeproj -scheme ForestRT -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/sim -quiet \
    CODE_SIGNING_ALLOWED=NO build
  echo "Built build/sim/Build/Products/Debug-iphonesimulator/ForestRT.app"
  exit 0
fi

xcodebuild -project ForestRT.xcodeproj -scheme ForestRT -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/device -quiet \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build

rm -rf build/Payload build/ForestRT.ipa
mkdir -p build/Payload
cp -R build/device/Build/Products/Release-iphoneos/ForestRT.app build/Payload/
(cd build && zip -qry ForestRT.ipa Payload)
rm -rf build/Payload
echo "Built $(pwd)/build/ForestRT.ipa"
