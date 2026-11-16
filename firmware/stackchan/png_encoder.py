"""Small, dependency-free PNG encoder for the CoreS3 RGB565 camera buffer."""

try:
    import binascii
except ImportError:
    import ubinascii as binascii


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_WIDTH = 640
MAX_HEIGHT = 480
_CRC32_POLYNOMIAL = 0xEDB88320


def _make_crc32_table():
    table = []
    for value in range(256):
        crc = value
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ _CRC32_POLYNOMIAL
            else:
                crc >>= 1
        table.append(crc)
    return tuple(table)


_CRC32_TABLE = _make_crc32_table()


def _write_u32(value):
    return bytes((
        (value >> 24) & 255,
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255,
    ))


def _crc32(data, progress=None):
    crc_function = getattr(binascii, "crc32", None)
    if crc_function is not None:
        result = crc_function(data) & 0xFFFFFFFF
        if progress is not None:
            progress()
        return result

    crc = 0xFFFFFFFF
    view = memoryview(data)
    for offset in range(0, len(data), 4096):
        for value in view[offset:offset + 4096]:
            table_index = (crc ^ value) & 0xFF
            crc = (crc >> 8) ^ _CRC32_TABLE[table_index]
        if progress is not None:
            progress()
    return crc ^ 0xFFFFFFFF


def _chunk(kind, data, progress=None):
    payload = kind + data
    return _write_u32(len(data)) + payload + _write_u32(_crc32(payload, progress))


def _adler32(data, progress=None):
    first = 1
    second = 0
    offset = 0
    while offset < len(data):
        stop = min(offset + 5552, len(data))
        while offset < stop:
            first += data[offset]
            second += first
            offset += 1
        first %= 65521
        second %= 65521
        if progress is not None:
            progress()
    return (second << 16) | first


def _zlib_store(data, progress=None):
    output = bytearray(b"\x78\x01")
    offset = 0
    while offset < len(data):
        block_size = min(65535, len(data) - offset)
        final = offset + block_size == len(data)
        output.append(1 if final else 0)
        output.extend((
            block_size & 255,
            (block_size >> 8) & 255,
            (~block_size) & 255,
            ((~block_size) >> 8) & 255,
        ))
        output.extend(data[offset:offset + block_size])
        offset += block_size
        if progress is not None:
            progress()
    output.extend(_write_u32(_adler32(data, progress)))
    return output


def rgb565_to_png(pixel_data, width, height, progress=None):
    """Encode big-endian RGB565 pixels as a baseline RGB PNG."""
    if width < 1 or height < 1 or width > MAX_WIDTH or height > MAX_HEIGHT:
        raise ValueError("Image dimensions are outside the supported range")
    if len(pixel_data) != width * height * 2:
        raise ValueError("RGB565 buffer size does not match image dimensions")

    scanlines = bytearray(height * (width * 3 + 1))
    source_offset = 0
    target_offset = 0
    for _ in range(height):
        if progress is not None:
            progress()
        scanlines[target_offset] = 0
        target_offset += 1
        for _ in range(width):
            pixel = (pixel_data[source_offset] << 8) | pixel_data[source_offset + 1]
            source_offset += 2
            red = (pixel >> 11) & 31
            green = (pixel >> 5) & 63
            blue = pixel & 31
            scanlines[target_offset] = (red * 255) // 31
            scanlines[target_offset + 1] = (green * 255) // 63
            scanlines[target_offset + 2] = (blue * 255) // 31
            target_offset += 3

    header = _write_u32(width) + _write_u32(height) + b"\x08\x02\x00\x00\x00"
    return (PNG_SIGNATURE + _chunk(b"IHDR", header, progress)
            + _chunk(b"IDAT", _zlib_store(scanlines, progress), progress)
            + _chunk(b"IEND", b"", progress))
