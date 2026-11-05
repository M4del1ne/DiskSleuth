#!/usr/bin/env bash
# Builds static libraries of libewf and The Sleuth Kit into deps/.
# Must run inside MSYS2 MINGW64; use scripts/build-deps.ps1 to call it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/downloads"
SRC="$ROOT/third_party/src"
PREFIX="$ROOT/deps"
JOBS="$(nproc)"

LIBEWF_TGZ="libewf-experimental-20260924.tar.gz"
LIBEWF_DIR="libewf-20260924"
TSK_TGZ="sleuthkit-4.15.0.tar.gz"
TSK_DIR="sleuthkit-4.15.0"

if [ "${MSYSTEM:-}" != "MINGW64" ]; then
  echo "run this inside MSYS2 MINGW64 (current MSYSTEM=${MSYSTEM:-unset})" >&2
  exit 1
fi

mkdir -p "$SRC" "$PREFIX"

# link everything statically so we never load the old libstdc++/libwinpthread other software put into System32
export LDFLAGS="-static ${LDFLAGS:-}"

unpack() { # $1=tgz $2=dir
  if [ ! -d "$SRC/$2" ]; then
    echo ">>> extracting $1"
    tar xzf "$DL/$1" -C "$SRC"
  fi
}

# ---------- libewf ----------
unpack "$LIBEWF_TGZ" "$LIBEWF_DIR"
if [ ! -f "$PREFIX/lib/libewf.a" ]; then
  echo ">>> building libewf"
  cd "$SRC/$LIBEWF_DIR"
  # UNICODE/_UNICODE: libewf keeps file names in UTF-16. Without it even the wide-character API converts
  # to the ANSI code page first, non-ASCII paths lose characters and fail to open (TSK then silently falls back to raw).
  CPPFLAGS="-DUNICODE -D_UNICODE ${CPPFLAGS:-}" \
  ./configure --prefix="$PREFIX" \
    --enable-static --disable-shared \
    --enable-multi-threading-support \
    --with-zlib --with-bzip2=no --with-openssl=no --with-libfuse=no \
    --disable-nls --enable-python=no
  # Build the library only, not ewftools: in UNICODE mode they clash with MinGW's getopt/unistd.h,
  # and hashing/verification is done by our Go backend anyway.
  sed -i -E '/^\s+(ewftools|pyewf|manuals|tests) \\$/d' Makefile
  make -j"$JOBS"
  make install
fi

# ---------- The Sleuth Kit ----------
unpack "$TSK_TGZ" "$TSK_DIR"
# compatibility patch: newer libewf renamed libewf_handle_read_random to libewf_handle_read_buffer_at_offset (same parameters)
sed -i 's/libewf_handle_read_random(/libewf_handle_read_buffer_at_offset(/' "$SRC/$TSK_DIR/tsk/img/ewf.cpp"
if [ ! -f "$PREFIX/lib/libtsk.a" ]; then
  echo ">>> building The Sleuth Kit"
  cd "$SRC/$TSK_DIR"
  CPPFLAGS="-I$PREFIX/include" LDFLAGS="$LDFLAGS -L$PREFIX/lib" \
  ./configure --prefix="$PREFIX" \
    --enable-static --disable-shared \
    --disable-java --disable-cppunit \
    --with-libewf="$PREFIX" \
    --without-afflib --without-libvhdi --without-libvmdk --without-libvslvm --without-libbfio
  make -j"$JOBS"
  make install
fi

echo ">>> done, output in $PREFIX"
ls "$PREFIX/lib"

# The command line tools in deps/bin (fls, ewfinfo, ...) are only used for cross-checking. libtool ignores -static,
# so they still need the MinGW runtime DLLs; copy matching DLLs next to the exes so the old ones in System32 are not loaded.
mkdir -p "$PREFIX/bin"
cp -f /mingw64/bin/libwinpthread-1.dll /mingw64/bin/libgcc_s_seh-1.dll /mingw64/bin/libstdc++-6.dll /mingw64/bin/zlib1.dll "$PREFIX/bin/"
