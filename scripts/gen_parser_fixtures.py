#!/usr/bin/env python3
"""Generate the parser format-detection sample fixtures.

This script emits two small, self-authored sample documents used by the
`tests/format_detection.rs` integration test:

  * tests/fixtures/sample.hwp   — a real HWP 5 binary container (CFBF / OLE2),
                                   detected from the `D0 CF 11 E0 A1 B1 1A E1`
                                   compound-file magic.
  * tests/fixtures/sample.hwpx  — a real HWPX package (ZIP of OWPML XML),
                                   detected from the `50 4B 03 04` ZIP magic.

Both fixtures are SYNTHESISED here, not exported from Hancom Office: they
carry no licensed Hancom/Microsoft fonts or proprietary content, so they are
safe to commit under the project's MIT license. They are intentionally
minimal — just enough for the format-detection + parsing module to (a) detect
the correct container format and (b) return a non-empty document model.

The `.hwp` CFBF layout is a byte-for-byte port of the crate's own
`build_minimal_cfbf` test-fixture builder (src/parser/cfb.rs), so the
hand-rolled Rust CFB reader walks it exactly. The `.hwpx` is produced with the
standard library `zipfile` module (the same OPC/OCF ZIP-of-XML convention
EPUB and ODF use).

Re-run with:  python3 scripts/gen_parser_fixtures.py
The integration test (`cargo test --test format_detection`) re-validates the
emitted bytes through the crate's real parser, so any drift is caught there.
"""

import os
import struct
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")

# --- CFBF constants (mirror src/parser/cfb.rs) ---
CFB_SIGNATURE = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
OBJ_TYPE_STREAM = 2
OBJ_TYPE_ROOT = 5
HEADER_DIFAT_OFFSET = 76
HEADER_DIFAT_ENTRIES = 109
DIR_ENTRY_SIZE = 128
SECTOR = 512
MINI_SECTOR = 64


def hwp_file_header_stream() -> bytes:
    """The 40-byte HWP 5 FileHeader stream: 17-byte ASCII signature padded to
    32 bytes, a little-endian 5.1.0.0 version, and a zeroed properties field."""
    sig = b"HWP Document File"
    buf = bytearray(sig)
    buf.extend(b"\x00" * (32 - len(sig)))  # pad signature region to 32 bytes
    buf.extend(bytes([0x00, 0x00, 0x01, 0x05]))  # version [build,micro,minor,major] = 5.1.0.0
    buf.extend(bytes([0x00, 0x00, 0x00, 0x00]))  # properties = 0 (uncompressed)
    assert len(buf) == 40
    return bytes(buf)


def build_minimal_cfbf(stream_name: str, stream_data: bytes) -> bytes:
    """Byte-exact, spec-valid minimal CFBF (v3 / 512-byte sectors) holding a
    single mini-stream. A direct port of `build_minimal_cfbf` in
    src/parser/cfb.rs so the crate's CFB reader walks it identically."""
    assert len(stream_data) <= SECTOR

    n_mini = max((len(stream_data) + MINI_SECTOR - 1) // MINI_SECTOR, 1)
    mini_stream_size = n_mini * MINI_SECTOR
    assert mini_stream_size <= SECTOR

    buf = bytearray(SECTOR * 5)  # header + 4 sectors

    def put_u16(off, v):
        struct.pack_into("<H", buf, off, v)

    def put_u32(off, v):
        struct.pack_into("<I", buf, off, v)

    def put_u64(off, v):
        struct.pack_into("<Q", buf, off, v)

    # ---- Header (offset 0) ----
    buf[0:8] = CFB_SIGNATURE
    put_u16(24, 0x003E)  # minor version
    put_u16(26, 0x0003)  # major version (v3)
    put_u16(28, 0xFFFE)  # byte order (little-endian)
    put_u16(30, 9)       # sector shift -> 512-byte sectors
    put_u16(32, 6)       # mini sector shift -> 64-byte mini sectors
    put_u32(40, 0)       # number of directory sectors (0 for v3)
    put_u32(44, 1)       # number of FAT sectors
    put_u32(48, 1)       # first directory sector
    put_u32(56, 4096)    # mini-stream cutoff
    put_u32(60, 2)       # first mini-FAT sector
    put_u32(64, 1)       # number of mini-FAT sectors
    put_u32(68, ENDOFCHAIN)  # first DIFAT sector (none)
    put_u32(72, 0)       # number of DIFAT sectors

    # Inline DIFAT: entry 0 -> FAT sector 0; rest free.
    put_u32(HEADER_DIFAT_OFFSET, 0)
    for i in range(1, HEADER_DIFAT_ENTRIES):
        put_u32(HEADER_DIFAT_OFFSET + i * 4, FREESECT)

    # ---- Sector 0: FAT (offset 512) ----
    fat_off = SECTOR
    entries_per_sector = SECTOR // 4  # 128
    for i in range(entries_per_sector):
        put_u32(fat_off + i * 4, FREESECT)
    put_u32(fat_off + 0, FATSECT)       # sector 0 = the FAT
    put_u32(fat_off + 4, ENDOFCHAIN)    # sector 1 = directory
    put_u32(fat_off + 8, ENDOFCHAIN)    # sector 2 = mini-FAT
    put_u32(fat_off + 12, ENDOFCHAIN)   # sector 3 = mini-stream container

    # ---- Sector 1: directory (offset 1024) ----
    dir_off = SECTOR * 2

    def put_name(entry_off, name):
        i = entry_off
        for u in name.encode("utf-16-le"):
            buf[i] = u
            i += 1
        name_len = (len(name) + 1) * 2  # incl. NUL terminator
        struct.pack_into("<H", buf, entry_off + 64, name_len)

    # Entry 0: Root Entry (object type 5), backs the mini stream.
    e0 = dir_off
    put_name(e0, "Root Entry")
    buf[e0 + 66] = OBJ_TYPE_ROOT
    buf[e0 + 67] = 1            # colour = black
    put_u32(e0 + 68, FREESECT)  # left  = NOSTREAM
    put_u32(e0 + 72, FREESECT)  # right = NOSTREAM
    put_u32(e0 + 76, 1)         # child = entry 1
    put_u32(e0 + 116, 3)        # mini stream starts at regular sector 3
    put_u64(e0 + 120, mini_stream_size)

    # Entry 1: the named stream (object type 2).
    e1 = dir_off + DIR_ENTRY_SIZE
    put_name(e1, stream_name)
    buf[e1 + 66] = OBJ_TYPE_STREAM
    buf[e1 + 67] = 1
    put_u32(e1 + 68, FREESECT)
    put_u32(e1 + 72, FREESECT)
    put_u32(e1 + 76, FREESECT)
    put_u32(e1 + 116, 0)                  # first mini sector
    put_u64(e1 + 120, len(stream_data))   # exact byte size

    # ---- Sector 2: mini FAT (offset 1536) ----
    mfat_off = SECTOR * 3
    for i in range(entries_per_sector):
        put_u32(mfat_off + i * 4, FREESECT)
    for j in range(n_mini):
        nxt = (j + 1) if (j + 1 < n_mini) else ENDOFCHAIN
        put_u32(mfat_off + j * 4, nxt)

    # ---- Sector 3: mini-stream container (offset 2048) ----
    mstream_off = SECTOR * 4
    buf[mstream_off:mstream_off + len(stream_data)] = stream_data

    return bytes(buf)


# A realistic minimal OWPML section part with two paragraphs of Korean text
# plus an entity-escaped run, mirroring the crate's own SAMPLE_SECTION_XML.
SECTION_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"\n'
    '        xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">\n'
    '  <hp:p paraPrIDRef="0">\n'
    '    <hp:run charPrIDRef="0"><hp:t>대한민국 정부 문서</hp:t></hp:run>\n'
    '  </hp:p>\n'
    '  <hp:p paraPrIDRef="0">\n'
    '    <hp:run charPrIDRef="0"><hp:t>제1조 &amp; 제2조 &lt;시행&gt;</hp:t></hp:run>\n'
    '  </hp:p>\n'
    '</hs:sec>'
)

HEADER_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">\n'
    '  <hh:fontfaces>\n'
    '    <hh:fontface lang="HANGUL">\n'
    '      <hh:font id="0" face="함초롬바탕" type="TTF"/>\n'
    '    </hh:fontface>\n'
    '  </hh:fontfaces>\n'
    '</hh:head>'
)


def build_hwpx(path: str):
    """Write a real HWPX (ZIP-of-XML) package: an uncompressed `mimetype`
    part first (OCF convention), then header + section parts (DEFLATE)."""
    with zipfile.ZipFile(path, "w") as zf:
        # mimetype must be stored uncompressed and first.
        zf.writestr("mimetype", b"application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("Contents/header.xml", HEADER_XML.encode("utf-8"),
                    compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("Contents/section0.xml", SECTION_XML.encode("utf-8"),
                    compress_type=zipfile.ZIP_DEFLATED)


def main():
    os.makedirs(FIXTURES, exist_ok=True)

    hwp_path = os.path.join(FIXTURES, "sample.hwp")
    cfbf = build_minimal_cfbf("FileHeader", hwp_file_header_stream())
    with open(hwp_path, "wb") as f:
        f.write(cfbf)
    print(f"wrote {hwp_path} ({len(cfbf)} bytes, CFBF magic {cfbf[:8].hex()})")

    hwpx_path = os.path.join(FIXTURES, "sample.hwpx")
    build_hwpx(hwpx_path)
    size = os.path.getsize(hwpx_path)
    with open(hwpx_path, "rb") as f:
        head = f.read(4)
    print(f"wrote {hwpx_path} ({size} bytes, ZIP magic {head.hex()})")


if __name__ == "__main__":
    main()
