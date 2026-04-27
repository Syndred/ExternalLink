"""Generate PNG icon files for Chrome extension."""
import struct
import zlib
import os

def create_png(width, height, color_rgb):
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc
    
    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter none
        for x in range(width):
            raw += bytes(color_rgb)
    
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend


def main():
    icons_dir = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')
    os.makedirs(icons_dir, exist_ok=True)
    
    # Sky blue #0284c7
    for size, name in [(16, 'icon16'), (48, 'icon48'), (128, 'icon128')]:
        data = create_png(size, size, (2, 132, 199))
        path = os.path.join(icons_dir, f'{name}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(f'Created {path} ({size}x{size})')


if __name__ == '__main__':
    main()