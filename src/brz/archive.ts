import { decompressZstd } from '../codecs/zstd';

const BRZ_MAGIC = [66, 82, 90]; // 'BRZ'

export enum CompressionMethod {
  None = 0,
  GenericZstd = 1,
}

interface BlobEntry {
  method: CompressionMethod;
  sizeCompressed: number;
  sizeUncompressed: number;
  offset: number;
}

interface FileEntry {
  path: string;
  blobId: number;
  method: CompressionMethod;
  sizeCompressed: number;
  sizeUncompressed: number;
}

function readInt32LE(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function normalisePath(path: string): string {
  // Normalise to forward slashes to avoid platform differences.
  return path.replace(/\\/g, '/');
}

export class BrzArchive {
  private readonly blobs: BlobEntry[] = [];
  private readonly blobData: Uint8Array;
  private readonly files = new Map<string, FileEntry>();

  constructor(private readonly source: Uint8Array) {
    if (source.length < 3) {
      throw new Error('BRZ buffer too small');
    }

    if (
      source[0] !== BRZ_MAGIC[0] ||
      source[1] !== BRZ_MAGIC[1] ||
      source[2] !== BRZ_MAGIC[2]
    ) {
      throw new Error('Not a BRZ archive');
    }

    const view = new DataView(
      source.buffer,
      source.byteOffset,
      source.byteLength
    );

    let offset = 3;
    const formatVersion = source[offset++];
    if (formatVersion !== 0) {
      throw new Error(`Unsupported BRZ format version ${formatVersion}`);
    }

    const indexMethod = source[offset++] as CompressionMethod;
    const indexSizeUncompressed = readInt32LE(view, offset);
    offset += 4;
    const indexSizeCompressed = readInt32LE(view, offset);
    offset += 4;

    // Skip the 32 byte BLAKE3 hash for now. (TODO: verify hash in a follow-up.)
    offset += 32;

    const indexCompressed = source.subarray(
      offset,
      offset + indexSizeCompressed
    );
    offset += indexSizeCompressed;

    const indexBytes =
      indexMethod === CompressionMethod.None
        ? indexCompressed
        : decompressZstd(indexCompressed, indexSizeUncompressed);

    this.parseIndex(indexBytes);

    this.blobData = source.subarray(offset);
  }

  private parseIndex(indexBytes: Uint8Array): void {
    const view = new DataView(
      indexBytes.buffer,
      indexBytes.byteOffset,
      indexBytes.byteLength
    );

    let offset = 0;
    const numFolders = readInt32LE(view, offset);
    offset += 4;
    const numFiles = readInt32LE(view, offset);
    offset += 4;
    const numBlobs = readInt32LE(view, offset);
    offset += 4;

    const folderParents: number[] = new Array(numFolders);
    for (let i = 0; i < numFolders; i++, offset += 4) {
      folderParents[i] = readInt32LE(view, offset);
    }

    const folderLengths: number[] = new Array(numFolders);
    for (let i = 0; i < numFolders; i++, offset += 2) {
      folderLengths[i] = readUint16LE(view, offset);
    }

    const folderNames: string[] = new Array(numFolders);
    for (let i = 0; i < numFolders; i++) {
      const length = folderLengths[i];
      const slice = indexBytes.subarray(offset, offset + length);
      offset += length;
      folderNames[i] = new TextDecoder().decode(slice);
    }

    const fileParents: number[] = new Array(numFiles);
    for (let i = 0; i < numFiles; i++, offset += 4) {
      fileParents[i] = readInt32LE(view, offset);
    }

    const fileContentIds: number[] = new Array(numFiles);
    for (let i = 0; i < numFiles; i++, offset += 4) {
      fileContentIds[i] = readInt32LE(view, offset);
    }

    const fileNameLengths: number[] = new Array(numFiles);
    for (let i = 0; i < numFiles; i++, offset += 2) {
      fileNameLengths[i] = readUint16LE(view, offset);
    }

    const fileNames: string[] = new Array(numFiles);
    for (let i = 0; i < numFiles; i++) {
      const length = fileNameLengths[i];
      const slice = indexBytes.subarray(offset, offset + length);
      offset += length;
      fileNames[i] = new TextDecoder().decode(slice);
    }

    const compressionMethods: CompressionMethod[] = new Array(numBlobs);
    for (let i = 0; i < numBlobs; i++, offset += 1) {
      compressionMethods[i] = indexBytes[offset] as CompressionMethod;
    }

    const sizesUncompressed: number[] = new Array(numBlobs);
    for (let i = 0; i < numBlobs; i++, offset += 4) {
      const value = readInt32LE(view, offset);
      if (value < 0) {
        throw new Error('Negative uncompressed blob size');
      }
      sizesUncompressed[i] = value;
    }

    const sizesCompressed: number[] = new Array(numBlobs);
    for (let i = 0; i < numBlobs; i++, offset += 4) {
      const value = readInt32LE(view, offset);
      if (value < 0) {
        throw new Error('Negative compressed blob size');
      }
      sizesCompressed[i] = value;
    }

    // Skip hash table: 32 bytes per blob.
    offset += numBlobs * 32;

    let blobOffset = 0;
    for (let i = 0; i < numBlobs; i++) {
      const method = compressionMethods[i];
      const sizeCompressed = sizesCompressed[i];
      const sizeUncompressed = sizesUncompressed[i];
      const storedSize =
        method === CompressionMethod.None ? sizeUncompressed : sizeCompressed;

      this.blobs.push({
        method,
        sizeCompressed,
        sizeUncompressed,
        offset: blobOffset,
      });

      blobOffset += storedSize;
    }

    const folderPaths = new Array<string>(numFolders);
    const resolveFolderPath = (id: number): string => {
      if (id === -1) {
        return '';
      }
      const cached = folderPaths[id];
      if (cached !== undefined) {
        return cached;
      }
      const parent = folderParents[id];
      const parentPath = resolveFolderPath(parent);
      const path = parentPath
        ? `${parentPath}/${folderNames[id]}`
        : folderNames[id];
      folderPaths[id] = path;
      return path;
    };

    for (let i = 0; i < numFiles; i++) {
      const parent = fileParents[i];
      const blobId = fileContentIds[i];
      const folderPath = resolveFolderPath(parent);
      const fullPath = folderPath
        ? `${folderPath}/${fileNames[i]}`
        : fileNames[i];
      const normalised = normalisePath(fullPath);

      const entry: FileEntry = {
        path: normalised,
        blobId,
        method: blobId >= 0 ? this.blobs[blobId]?.method ?? CompressionMethod.None : CompressionMethod.None,
        sizeCompressed: blobId >= 0 ? this.blobs[blobId]?.sizeCompressed ?? 0 : 0,
        sizeUncompressed: blobId >= 0 ? this.blobs[blobId]?.sizeUncompressed ?? 0 : 0,
      };
      this.files.set(normalised, entry);
    }
  }

  listFiles(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  hasFile(path: string): boolean {
    return this.files.has(normalisePath(path));
  }

  readFile(path: string): Uint8Array {
    const entry = this.files.get(normalisePath(path));
    if (!entry) {
      throw new Error(`File not found in BRZ: ${path}`);
    }
    if (entry.blobId < 0) {
      return new Uint8Array();
    }
    const blob = this.blobs[entry.blobId];
    if (!blob) {
      throw new Error(`Missing blob ${entry.blobId} for file ${path}`);
    }
    const { offset } = blob;
    const storedSize =
      blob.method === CompressionMethod.None
        ? blob.sizeUncompressed
        : blob.sizeCompressed;
    const slice = this.blobData.subarray(offset, offset + storedSize);

    if (blob.method === CompressionMethod.None) {
      return slice.slice();
    }

    return decompressZstd(slice, blob.sizeUncompressed);
  }
}

