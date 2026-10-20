#!/bin/sh
# build/icon.svg 하나로 맥(.icns)·윈도우(.ico)·웹(favicon) 아이콘을 모두 만드는 스크립트. inkscape, magick, iconutil이 필요하다
set -e
cd "$(dirname "$0")/.."
inkscape build/icon.svg --export-type=png --export-filename=build/icon.png -w 1024 -h 1024 >/dev/null 2>&1

# 맥: iconset 폴더에 크기별 PNG를 만들고 icns로 묶는다
set_dir=$(mktemp -d)/icon.iconset
mkdir -p "$set_dir"
for s in 16 32 128 256 512; do
  magick build/icon.png -resize ${s}x${s} "$set_dir/icon_${s}x${s}.png"
  magick build/icon.png -resize $((s * 2))x$((s * 2)) "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o build/icon.icns

# 윈도우: 여러 크기를 담은 ico
magick build/icon.png -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico

# 웹: 브라우저 탭 아이콘과 홈 화면 아이콘
magick build/icon.png -resize 64x64 public/favicon.png
magick build/icon.png -resize 180x180 public/apple-touch-icon.png
echo "아이콘을 만들었습니다: build/icon.icns, build/icon.ico, public/favicon.png"
