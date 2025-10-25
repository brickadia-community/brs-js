/**
 * Minimal MessagePack reader tailored to Brickadia's msgpack-schema encoded streams.
 *
 * Supports the subset of tags used in `.schema` and `.mps` files:
 *  - positive/negative fixint
 *  - uint8/16/32
 *  - int8/16/32
 *  - float32/float64
 *  - fixstr/str8/str16/str32
 *  - fixarray/array16/array32
 *  - fixmap/map16/map32
 *  - bin8/bin16/bin32
 *  - nil, true, false
 *
 * The reader exposes primitive helpers (`readUnsigned`, `readString`, `readArrayHeader`, ...)
 * without trying to materialise higher level structures automatically. This gives us precise
 * control to follow the schema-defined layout where struct fields are emitted sequentially.
 */

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

export class MsgPackReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
  }

  clone(): MsgPackReader {
    const reader = new MsgPackReader(this.buffer);
    reader.offset = this.offset;
    return reader;
  }

  remaining(): number {
    return this.buffer.length - this.offset;
  }

  getOffset(): number {
    return this.offset;
  }

  setOffset(offset: number): void {
    if (offset < 0 || offset > this.buffer.length) {
      throw new RangeError('MsgPackReader offset out of bounds');
    }
    this.offset = offset;
  }

  private ensure(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new RangeError('Unexpected end of MessagePack buffer');
    }
  }

  private readUInt8(): number {
    this.ensure(1);
    const value = this.buffer[this.offset];
    this.offset += 1;
    return value;
  }

  private peekUInt8(): number {
    this.ensure(1);
    return this.buffer[this.offset];
  }

  private readUInt16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  private readUInt32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  private readInt8(): number {
    this.ensure(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private readInt16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  private readInt32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  private readFloat32(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  private readFloat64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  readNil(): void {
    const prefix = this.readUInt8();
    if (prefix !== 0xc0) {
      throw new Error(`Expected nil (0xc0), got 0x${prefix.toString(16)}`);
    }
  }

  readBool(): boolean {
    const prefix = this.readUInt8();
    if (prefix === 0xc2) return false;
    if (prefix === 0xc3) return true;
    throw new Error(`Expected bool, got 0x${prefix.toString(16)}`);
  }

  readNumber(): number {
    const prefix = this.readUInt8();

    // Positive fixint
    if (prefix <= 0x7f) {
      return prefix;
    }

    // Negative fixint
    if (prefix >= 0xe0) {
      return (prefix - 0x100) | 0;
    }

    switch (prefix) {
      case 0xcc:
        return this.readUInt8();
      case 0xcd:
        return this.readUInt16();
      case 0xce:
        return this.readUInt32();
      case 0xd0:
        return this.readInt8();
      case 0xd1:
        return this.readInt16();
      case 0xd2:
        return this.readInt32();
      case 0xca:
        return this.readFloat32();
      case 0xcb:
        return this.readFloat64();
      default:
        throw new Error(`Unsupported numeric prefix 0x${prefix.toString(16)}`);
    }
  }

  readUnsigned(): number {
    const value = this.readNumber();
    if (value < 0) {
      throw new Error('Expected unsigned integer');
    }
    return value;
  }

  readInt(): number {
    return this.readNumber();
  }

  readBytes(): Uint8Array {
    const prefix = this.readUInt8();
    let length: number;
    if (prefix >= 0xc4 && prefix <= 0xc6) {
      switch (prefix) {
        case 0xc4:
          length = this.readUInt8();
          break;
        case 0xc5:
          length = this.readUInt16();
          break;
        default:
          length = this.readUInt32();
          break;
      }
    } else if (prefix >= 0xa0 && prefix <= 0xbf) {
      // fixstr reused by schema for short ASCII strings; treat as bytes when needed.
      length = prefix & 0x1f;
    } else if (prefix === 0xd9) {
      length = this.readUInt8();
    } else if (prefix === 0xda) {
      length = this.readUInt16();
    } else if (prefix === 0xdb) {
      length = this.readUInt32();
    } else {
      throw new Error(`Expected binary/string prefix, got 0x${prefix.toString(16)}`);
    }

    this.ensure(length);
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readString(): string {
    const bytes = this.readBytes();
    if (!textDecoder) {
      throw new Error('TextDecoder not available in this environment');
    }
    return textDecoder.decode(bytes);
  }

  readArrayLength(): number {
    const prefix = this.readUInt8();
    if (prefix >= 0x90 && prefix <= 0x9f) {
      return prefix & 0x0f;
    }
    if (prefix === 0xdc) {
      return this.readUInt16();
    }
    if (prefix === 0xdd) {
      return this.readUInt32();
    }
    throw new Error(`Expected array prefix, got 0x${prefix.toString(16)}`);
  }

  readMapLength(): number {
    const prefix = this.readUInt8();
    if (prefix >= 0x80 && prefix <= 0x8f) {
      return prefix & 0x0f;
    }
    if (prefix === 0xde) {
      return this.readUInt16();
    }
    if (prefix === 0xdf) {
      return this.readUInt32();
    }
    throw new Error(`Expected map prefix, got 0x${prefix.toString(16)}`);
  }

  skip(): void {
    const prefix = this.readUInt8();

    // Positive fixint
    if (prefix <= 0x7f) return;
    // negative fixint
    if (prefix >= 0xe0) return;

    switch (prefix) {
      case 0xc0: // nil
      case 0xc2: // false
      case 0xc3: // true
        return;
      case 0xcc:
        this.offset += 1;
        return;
      case 0xcd:
      case 0xd0:
        this.offset += 2;
        return;
      case 0xce:
      case 0xd1:
      case 0xca:
        this.offset += 4;
        return;
      case 0xd2:
      case 0xcb:
        this.offset += 8;
        return;
      case 0xc4:
      case 0xd9: {
        const len = this.readUInt8();
        this.offset += len;
        return;
      }
      case 0xc5:
      case 0xda: {
        const len = this.readUInt16();
        this.offset += len;
        return;
      }
      case 0xc6:
      case 0xdb: {
        const len = this.readUInt32();
        this.offset += len;
        return;
      }
      case 0x90:
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97:
      case 0x98:
      case 0x99:
      case 0x9a:
      case 0x9b:
      case 0x9c:
      case 0x9d:
      case 0x9e:
      case 0x9f: {
        const len = prefix & 0x0f;
        for (let i = 0; i < len; i++) this.skip();
        return;
      }
      case 0xdc:
      case 0xdd: {
        const len = prefix === 0xdc ? this.readUInt16() : this.readUInt32();
        for (let i = 0; i < len; i++) this.skip();
        return;
      }
      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83:
      case 0x84:
      case 0x85:
      case 0x86:
      case 0x87:
      case 0x88:
      case 0x89:
      case 0x8a:
      case 0x8b:
      case 0x8c:
      case 0x8d:
      case 0x8e:
      case 0x8f: {
        const len = prefix & 0x0f;
        for (let i = 0; i < len; i++) {
          this.skip(); // key
          this.skip(); // value
        }
        return;
      }
      case 0xde:
      case 0xdf: {
        const len = prefix === 0xde ? this.readUInt16() : this.readUInt32();
        for (let i = 0; i < len; i++) {
          this.skip();
          this.skip();
        }
        return;
      }
      default:
        throw new Error(`Cannot skip unknown prefix 0x${prefix.toString(16)}`);
    }
  }

  readAny(): any {
    const prefix = this.peekUInt8();

    // positive fixint
    if (prefix <= 0x7f) {
      this.offset += 1;
      return prefix;
    }

    // negative fixint
    if (prefix >= 0xe0) {
      this.offset += 1;
      return (prefix - 0x100) | 0;
    }

    // strings
    if (
      (prefix >= 0xa0 && prefix <= 0xbf) ||
      prefix === 0xd9 ||
      prefix === 0xda ||
      prefix === 0xdb
    ) {
      return this.readString();
    }

    // arrays
    if ((prefix >= 0x90 && prefix <= 0x9f) || prefix === 0xdc || prefix === 0xdd) {
      const length = this.readArrayLength();
      const arr = new Array(length);
      for (let i = 0; i < length; i++) {
        arr[i] = this.readAny();
      }
      return arr;
    }

    // maps
    if ((prefix >= 0x80 && prefix <= 0x8f) || prefix === 0xde || prefix === 0xdf) {
      const length = this.readMapLength();
      const obj: Record<string, any> = {};
      for (let i = 0; i < length; i++) {
        const key = this.readAny();
        obj[typeof key === 'string' ? key : String(key)] = this.readAny();
      }
      return obj;
    }

    switch (prefix) {
      case 0xc0:
        this.readNil();
        return null;
      case 0xc2:
      case 0xc3:
        return this.readBool();
      case 0xc4:
      case 0xc5:
      case 0xc6:
        return this.readBytes();
      default:
        return this.readNumber();
    }
  }
}

export function readArray<T>(
  reader: MsgPackReader,
  callback: (index: number) => T
): T[] {
  const length = reader.readArrayLength();
  const result = new Array<T>(length);
  for (let i = 0; i < length; i++) {
    result[i] = callback(i);
  }
  return result;
}
