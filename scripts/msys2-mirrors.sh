#!/usr/bin/env bash
# Puts the Tsinghua / USTC mirrors first in the MSYS2 mirror lists (safe to run repeatedly). Run inside MSYS2.
set -euo pipefail
add_mirrors() { # $1=file $2=sub path
  grep -m1 "^Server" "$1" | grep -q tuna.tsinghua && return 0   # already first: skip
  sed -i "0,/^Server/s##Server = https://mirrors.tuna.tsinghua.edu.cn/msys2/$2\nServer = https://mirrors.ustc.edu.cn/msys2/$2\nServer#" "$1"
}
add_mirrors /etc/pacman.d/mirrorlist.mingw 'mingw/$repo/'
add_mirrors /etc/pacman.d/mirrorlist.msys  'msys/$arch/'
