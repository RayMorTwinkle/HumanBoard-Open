import { HumanBoardError } from "@humanboard/core-engine";

export interface ImageMetadata {
  readonly format: "png" | "jpeg";
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function uint16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

function uint32(data: Uint8Array, offset: number): number {
  return (
    data[offset]! * 0x1000000 +
    (data[offset + 1]! << 16) +
    (data[offset + 2]! << 8) +
    data[offset + 3]!
  );
}

function pngMetadata(data: Uint8Array): ImageMetadata | null {
  if (
    data.length < 24 ||
    PNG_SIGNATURE.some((value, index) => data[index] !== value) ||
    String.fromCharCode(...data.slice(12, 16)) !== "IHDR"
  ) {
    return null;
  }
  const width = uint32(data, 16);
  const height = uint32(data, 20);
  return width > 0 && height > 0
    ? { format: "png", mimeType: "image/png", width, height }
    : null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegMetadata(data: Uint8Array): ImageMetadata | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < data.length && data[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= data.length) {
      return null;
    }
    const marker = data[offset]!;
    offset += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 1 >= data.length) {
      return null;
    }
    const length = uint16(data, offset);
    if (length < 2 || offset + length > data.length) {
      return null;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) {
        return null;
      }
      const height = uint16(data, offset + 3);
      const width = uint16(data, offset + 5);
      return width > 0 && height > 0
        ? { format: "jpeg", mimeType: "image/jpeg", width, height }
        : null;
    }
    offset += length;
  }
  return null;
}

export function readImageMetadata(data: Uint8Array): ImageMetadata {
  const metadata = pngMetadata(data) ?? jpegMetadata(data);
  if (!metadata) {
    throw new HumanBoardError(
      "E_USAGE",
      "Unsupported image format; only PNG and JPEG are supported",
      {
        reason: "unsupported_image_format",
        signature: [...data.slice(0, 12)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join(" "),
      },
    );
  }
  if (
    metadata.width > 16384 ||
    metadata.height > 16384 ||
    metadata.width * metadata.height > 40_000_000
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Image exceeds the 40 megapixel / 16384px limit",
    );
  }
  return metadata;
}
