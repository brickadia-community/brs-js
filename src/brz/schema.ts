import { MsgPackReader } from './msgpack';
import {
  UnrealColor,
  WireGraphVariant,
  Vector,
  IntVector,
  UnrealType,
} from '../types';

export interface SchemaProperty {
  name: string;
  kind: 'type' | 'array' | 'flatArray' | 'map';
  valueType: string;
  keyType?: string;
}

export interface SchemaStruct {
  name: string;
  properties: SchemaProperty[];
}

export interface SchemaDefinition {
  enums: Map<string, Map<string, number>>;
  structs: Map<string, SchemaStruct>;
}

export interface SchemaContext {
  /**
   * Resolve asset references for `class`/`object` schema types.
   * Returns undefined when the asset index is unset or unknown.
   */
  resolveAsset?: (assetType: string, index: number) => string | undefined;
}

export interface StructValue {
  structName: string;
  value: Record<string, unknown>;
}

export function parseSchema(bytes: Uint8Array): SchemaDefinition {
  const reader = new MsgPackReader(bytes);

  const header = reader.readArrayLength();
  if (header !== 2) {
    throw new Error(`Unexpected schema header length ${header}`);
  }

  const enums = readEnums(reader);
  const structs = readStructs(reader);

  return { enums, structs };
}

function readEnums(reader: MsgPackReader): Map<string, Map<string, number>> {
  const length = reader.readMapLength();
  const enums = new Map<string, Map<string, number>>();
  for (let i = 0; i < length; i++) {
    const name = reader.readString();
    const valuesLen = reader.readMapLength();
    const values = new Map<string, number>();
    for (let j = 0; j < valuesLen; j++) {
      const key = reader.readString();
      const value = reader.readNumber();
      values.set(key, Number(value));
    }
    enums.set(name, values);
  }
  return enums;
}

function readStructs(reader: MsgPackReader): Map<string, SchemaStruct> {
  const length = reader.readMapLength();
  const structs = new Map<string, SchemaStruct>();

  for (let i = 0; i < length; i++) {
    const name = reader.readString();
    const propCount = reader.readMapLength();
    const properties: SchemaProperty[] = [];
    for (let j = 0; j < propCount; j++) {
      const propName = reader.readString();
      const prop = readProperty(reader, propName);
      properties.push(prop);
    }
    structs.set(name, { name, properties });
  }

  return structs;
}

function readProperty(reader: MsgPackReader, name: string): SchemaProperty {
  const descriptor = reader.readAny();

  if (typeof descriptor === 'string') {
    return { name, kind: 'type', valueType: descriptor };
  }

  if (Array.isArray(descriptor)) {
    if (descriptor.length === 0) {
      throw new Error(`Empty schema array for ${name}`);
    }
    const valueType = descriptor[0];
    if (typeof valueType !== 'string') {
      throw new Error(`Invalid schema array element for ${name}`);
    }
    if (descriptor.length === 1) {
      return { name, kind: 'array', valueType };
    }
    if (descriptor.length === 2 && descriptor[1] === null) {
      return { name, kind: 'flatArray', valueType };
    }
    throw new Error(`Unsupported schema array length ${descriptor.length} for ${name}`);
  }

  if (descriptor && typeof descriptor === 'object') {
    const entries = Object.entries(descriptor);
    if (entries.length !== 1) {
      throw new Error(`Unsupported schema map length ${entries.length} for ${name}`);
    }
    const [keyType, valueType] = entries[0];
    if (typeof keyType !== 'string' || typeof valueType !== 'string') {
      throw new Error(`Invalid schema map entry for ${name}`);
    }
    return {
      name,
      kind: 'map',
      valueType,
      keyType,
    };
  }

  throw new Error(`Unsupported schema property descriptor for ${name}`);
}

export class SchemaDecoder {
  constructor(
    private readonly schema: SchemaDefinition,
    private readonly context: SchemaContext = {}
  ) {}

  readStruct(reader: MsgPackReader, structName: string): StructValue {
    const struct = this.schema.structs.get(structName);
    if (!struct) {
      throw new Error(`Unknown schema struct ${structName}`);
    }
    const result: Record<string, unknown> = {};
    for (const prop of struct.properties) {
      result[prop.name] = this.readProperty(reader, prop);
    }
    return { structName, value: result };
  }

  private readProperty(reader: MsgPackReader, prop: SchemaProperty): unknown {
    switch (prop.kind) {
      case 'type':
        return this.readValue(reader, prop.valueType);
      case 'array': {
        const length = reader.readArrayLength();
        const arr = new Array<unknown>(length);
        for (let i = 0; i < length; i++) {
          arr[i] = this.readValue(reader, prop.valueType);
        }
        return arr;
      }
      case 'flatArray':
        return this.readFlatArray(reader, prop.valueType);
      case 'map': {
        const len = reader.readMapLength();
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < len; i++) {
          const key = this.readValue(reader, prop.keyType ?? 'str');
          const value = this.readValue(reader, prop.valueType);
          map.set(key, value);
        }
        return map;
      }
      default:
        return undefined;
    }
  }

  private readFlatArray(reader: MsgPackReader, type: string): unknown[] {
    const bytes = reader.readBytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
      case 'u8':
        return Array.from(bytes);
      case 'bool':
        return Array.from(bytes).map(b => b !== 0);
      case 'i8':
        return Array.from(bytes, b => ((b + 0x80) & 0xff) - 0x80);
      case 'u16':
        return readFlat(view, 2, (dv, offset) => dv.getUint16(offset, true));
      case 'i16':
        return readFlat(view, 2, (dv, offset) => dv.getInt16(offset, true));
      case 'u32':
        return readFlat(view, 4, (dv, offset) => dv.getUint32(offset, true));
      case 'i32':
        return readFlat(view, 4, (dv, offset) => dv.getInt32(offset, true));
      case 'u64':
        return readFlat(view, 8, (dv, offset) =>
          Number(dv.getBigUint64(offset, true))
        );
      case 'i64':
        return readFlat(view, 8, (dv, offset) =>
          Number(dv.getBigInt64(offset, true))
        );
      case 'f32':
        return readFlat(view, 4, (dv, offset) => dv.getFloat32(offset, true));
      case 'f64':
        return readFlat(view, 8, (dv, offset) => dv.getFloat64(offset, true));
      default: {
        const struct = this.schema.structs.get(type);
        if (!struct) {
          throw new Error(`Unsupported flat array type ${type}`);
        }
        const itemSize = computeStructByteSize(struct, this.schema);
        if (itemSize <= 0 || view.byteLength % itemSize !== 0) {
          throw new Error(`Cannot compute flat struct size for ${type}`);
        }
        const count = view.byteLength / itemSize;
        const items: unknown[] = new Array(count);
        let offset = 0;
        for (let i = 0; i < count; i++) {
          const [structValue, consumed] = decodeFlatStruct(
            struct,
            view,
            offset,
            this.schema
          );
          offset += consumed;
          items[i] = structValue;
        }
        return items;
      }
    }
  }

  private readValue(reader: MsgPackReader, type: string): unknown {
    switch (type) {
      case 'bool':
        return reader.readBool();
      case 'u8':
      case 'u16':
      case 'u32':
      case 'u64':
        return reader.readUnsigned();
      case 'i8':
      case 'i16':
      case 'i32':
      case 'i64':
        return reader.readNumber();
      case 'f32':
      case 'f64':
        return reader.readNumber();
      case 'str':
        return reader.readString();
      case 'class':
      case 'object': {
        const idx = reader.readNumber();
        if (idx < 0) return undefined;
        const resolver = this.context.resolveAsset;
        if (!resolver) return idx;
        return resolver(type, idx);
      }
      case 'wire_graph_variant':
        return this.readWireGraphVariant(reader);
      case 'wire_graph_prim_math_variant':
        return this.readWireGraphPrimVariant(reader);
      default: {
        const struct = this.schema.structs.get(type);
        if (struct) {
          return this.readStruct(reader, type);
        }
        // fallback: attempt best effort using generic reader
        return reader.readAny();
      }
    }
  }

  private readWireGraphVariant(reader: MsgPackReader): WireGraphVariant {
    const kind = reader.readUnsigned();
    switch (kind) {
      case 0:
        return { number: reader.readNumber() };
      case 1:
        return { integer: reader.readNumber() };
      case 2:
        return { bool: reader.readBool() };
      case 3:
        return { object: true };
      case 4:
        return { exec: true };
      default:
        throw new Error(`Unknown WireGraphVariant discriminator ${kind}`);
    }
  }

  private readWireGraphPrimVariant(reader: MsgPackReader): WireGraphVariant {
    const kind = reader.readUnsigned();
    switch (kind) {
      case 0:
        return { number: reader.readNumber() };
      case 1:
        return { integer: reader.readNumber() };
      default:
        throw new Error(
          `Unknown WireGraphPrimMathVariant discriminator ${kind}`
        );
    }
  }
}

function readFlat<T>(
  view: DataView,
  stride: number,
  getter: (view: DataView, offset: number) => T
): T[] {
  if (view.byteLength % stride !== 0) {
    throw new Error('Flat array misaligned');
  }
  const length = view.byteLength / stride;
  const result = new Array<T>(length);
  for (let i = 0, offset = 0; i < length; i++, offset += stride) {
    result[i] = getter(view, offset);
  }
  return result;
}

function computeStructByteSize(
  struct: SchemaStruct,
  schema: SchemaDefinition
): number {
  let size = 0;
  for (const prop of struct.properties) {
    if (prop.kind !== 'type') {
      return 0;
    }
    size += primitiveByteSize(prop.valueType, schema);
  }
  return size;
}

function primitiveByteSize(
  type: string,
  schema: SchemaDefinition
): number {
  switch (type) {
    case 'bool':
    case 'u8':
    case 'i8':
      return 1;
    case 'u16':
    case 'i16':
      return 2;
    case 'u32':
    case 'i32':
    case 'f32':
      return 4;
    case 'u64':
    case 'i64':
    case 'f64':
      return 8;
    default: {
      const struct = schema.structs.get(type);
      if (!struct) return 0;
      return computeStructByteSize(struct, schema);
    }
  }
}

function decodeFlatStruct(
  struct: SchemaStruct,
  view: DataView,
  offset: number,
  schema: SchemaDefinition
): [StructValue, number] {
  const result: Record<string, unknown> = {};
  let cursor = offset;
  for (const prop of struct.properties) {
    if (prop.kind !== 'type') {
      throw new Error(
        `Flat struct ${struct.name} contains unsupported property ${prop.name}`
      );
    }
    const [value, consumed] = readFlatPrimitive(
      prop.valueType,
      view,
      cursor,
      schema
    );
    cursor += consumed;
    result[prop.name] = value;
  }
  return [{ structName: struct.name, value: result }, cursor - offset];
}

function readFlatPrimitive(
  type: string,
  view: DataView,
  offset: number,
  schema: SchemaDefinition
): [unknown, number] {
  switch (type) {
    case 'bool':
      return [view.getUint8(offset) !== 0, 1];
    case 'u8':
      return [view.getUint8(offset), 1];
    case 'i8':
      return [view.getInt8(offset), 1];
    case 'u16':
      return [view.getUint16(offset, true), 2];
    case 'i16':
      return [view.getInt16(offset, true), 2];
    case 'u32':
      return [view.getUint32(offset, true), 4];
    case 'i32':
      return [view.getInt32(offset, true), 4];
    case 'u64':
      return [Number(view.getBigUint64(offset, true)), 8];
    case 'i64':
      return [Number(view.getBigInt64(offset, true)), 8];
    case 'f32':
      return [view.getFloat32(offset, true), 4];
    case 'f64':
      return [view.getFloat64(offset, true), 8];
    default: {
      const struct = schema.structs.get(type);
      if (!struct) {
        throw new Error(`Unknown flat primitive type ${type}`);
      }
      const [nested, consumed] = decodeFlatStruct(struct, view, offset, schema);
      return [nested, consumed];
    }
  }
}

export function convertStructToUnreal(
  struct: StructValue
): UnrealType | Record<string, unknown> {
  const { structName, value } = struct;
  switch (structName) {
    case 'Color':
    case 'BRSavedBrickColor': {
      const r = Number(value.R ?? value.r ?? 0);
      const g = Number(value.G ?? value.g ?? 0);
      const b = Number(value.B ?? value.b ?? 0);
      const a = Number(value.A ?? value.a ?? 0);
      return [r, g, b, a] as UnrealColor;
    }
    case 'LinearColor': {
      const r = Number(value.R ?? 0);
      const g = Number(value.G ?? 0);
      const b = Number(value.B ?? 0);
      const a = Number(value.A ?? 0);
      return [r, g, b, a] as UnrealColor;
    }
    case 'Rotator3f':
    case 'Rotator3d':
    case 'Rotator': {
      const pitch = Number(value.Pitch ?? 0);
      const yaw = Number(value.Yaw ?? 0);
      const roll = Number(value.Roll ?? 0);
      return [pitch, yaw, roll] as Vector;
    }
    case 'Vector3f':
    case 'Vector3d':
    case 'Vector': {
      const x = Number(value.X ?? 0);
      const y = Number(value.Y ?? 0);
      const z = Number(value.Z ?? 0);
      return [x, y, z] as Vector;
    }
    case 'IntVector': {
      const x = Number(value.X ?? 0);
      const y = Number(value.Y ?? 0);
      const z = Number(value.Z ?? 0);
      return [x, y, z] as IntVector;
    }
    case 'BRGuid':
    case 'Guid': {
      const a = Number(value.A ?? 0) >>> 0;
      const b = Number(value.B ?? 0) >>> 0;
      const c = Number(value.C ?? 0) >>> 0;
      const d = Number(value.D ?? 0) >>> 0;
      return `${toHex(a, 8)}-${toHex(b >>> 16, 4)}${toHex(b & 0xffff, 4)}-${toHex(
        c >>> 16,
        4
      )}${toHex(c & 0xffff, 4)}-${toHex(d >>> 16, 4)}${toHex(d & 0xffff, 4)}`;
    }
    default:
      return value;
  }
}

function toHex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}
