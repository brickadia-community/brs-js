import { MsgPackReader, readArray } from './msgpack';
import {
  SchemaDefinition,
  SchemaDecoder,
  SchemaProperty,
  SchemaStruct,
  StructValue,
  convertStructToUnreal,
} from './schema';
import {
  Brick,
  Collision,
  Direction,
  Rotation,
  UnrealColor,
  Vector,
  AppliedComponent,
  UnrealType,
  Wire,
  DynamicGridInfo,
} from '../types';

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const CHUNK_SIZE = 2048;
const CHUNK_HALF = CHUNK_SIZE / 2;

export interface ParsedGlobalData {
  entityTypeNames: string[];
  basicBrickAssets: string[];
  proceduralBrickAssets: string[];
  materialAssets: string[];
  componentTypeNames: string[];
  componentDataStructNames: string[];
  componentWirePortNames: string[];
  externalAssetReferences: Array<{ assetType: string; assetName: string }>;
  proceduralBrickStartingIndex: number;
}

export interface OwnerRecord {
  id: string;
  name: string;
  displayName: string;
  brickCount: number;
}

interface BrickSizeCounter {
  assetIndex: number;
  numSizes: number;
}

interface BrickSize {
  x: number;
  y: number;
  z: number;
}

interface RelativePosition {
  x: number;
  y: number;
  z: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BrickChunkData {
  proceduralBrickStartingIndex: number;
  brickSizeCounters: BrickSizeCounter[];
  brickSizes: BrickSize[];
  brickTypeIndices: number[];
  ownerIndices: number[];
  relativePositions: RelativePosition[];
  orientations: Uint8Array;
  collisionPlayer: Uint8Array;
  collisionWeapon: Uint8Array;
  collisionInteraction: Uint8Array;
  collisionTool: Uint8Array;
  collisionPhysics: Uint8Array;
  visibility: Uint8Array;
  materialIndices: Uint8Array;
  colors: Rgba[];
}

export interface IntermediateBrick {
  assetName: string;
  size: Vector;
  position: Vector;
  localPosition?: Vector;
  gridId?: number;
  direction: Direction;
  rotation: Rotation;
  collision: Collision;
  visibility: boolean;
  materialIndex: number;
  materialIntensity: number;
  color: UnrealColor;
  ownerIndex: number;
  physicalIndex: number;
  components?: Record<string, AppliedComponent>;
}

export interface ComponentInstance {
  typeName: string;
  localBrickIndex: number;
  properties: AppliedComponent;
}

export interface ComponentDefinitionInfo {
  version: number;
  propertyTypes: Record<string, string>;
}

export interface ComponentChunkParseResult {
  instances: ComponentInstance[];
  definitions: Map<string, ComponentDefinitionInfo>;
}

export interface LocalWireEndpoint {
  brickIndex: number;
  componentTypeIndex: number;
  portIndex: number;
}

export interface RemoteWireEndpoint extends LocalWireEndpoint {
  gridPersistentIndex: number;
  chunk: { x: number; y: number; z: number };
}

export interface ParsedWireChunk {
  local: Array<{ source: LocalWireEndpoint; target: LocalWireEndpoint }>;
  remote: Array<{ source: RemoteWireEndpoint; target: LocalWireEndpoint }>;
}

type Quaternion = [number, number, number, number];

export interface GridTransform {
  position: Vector;
  rotation: Quaternion;
}

export interface ParsedEntity {
  typeName: string;
  persistentIndex: number;
  ownerIndex: number;
  position: Vector;
  rotation: Quaternion;
}

function ensureDecoder(): TextDecoder {
  if (!textDecoder) {
    throw new Error('TextDecoder not available in this environment');
  }
  return textDecoder;
}

function readStringArray(reader: MsgPackReader): string[] {
  const decoder = ensureDecoder();
  return readArray(reader, () => decoder.decode(reader.readBytes()));
}

function readNumberArray(reader: MsgPackReader): number[] {
  return readArray(reader, () => reader.readUnsigned());
}

function readFlatBytes(reader: MsgPackReader): Uint8Array {
  // MessagePack encodes flat arrays as binary data.
  return reader.readBytes().slice();
}

function readRelativePositions(reader: MsgPackReader): RelativePosition[] {
  const data = readFlatBytes(reader);
  if (data.length % 6 !== 0) {
    throw new Error('Relative position buffer misaligned');
  }
  const positions: RelativePosition[] = new Array(data.length / 6);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  for (let i = 0; i < positions.length; i++) {
    const x = view.getInt16(offset, true);
    offset += 2;
    const y = view.getInt16(offset, true);
    offset += 2;
    const z = view.getInt16(offset, true);
    offset += 2;
    positions[i] = { x, y, z };
  }
  return positions;
}

function readColors(reader: MsgPackReader): Rgba[] {
  const data = readFlatBytes(reader);
  if (data.length % 4 !== 0) {
    throw new Error('Color buffer misaligned');
  }
  const colors: Rgba[] = new Array(data.length / 4);
  for (let i = 0, offset = 0; i < colors.length; i++, offset += 4) {
    colors[i] = {
      r: data[offset],
      g: data[offset + 1],
      b: data[offset + 2],
      a: data[offset + 3],
    };
  }
  return colors;
}

export function parseGlobalData(bytes: Uint8Array): ParsedGlobalData {
  const reader = new MsgPackReader(bytes);
  const entityTypeNames = readStringArray(reader);
  const basicBrickAssets = readStringArray(reader);
  const proceduralBrickAssets = readStringArray(reader);
  const materialAssets = readStringArray(reader);
  const componentTypeNames = readStringArray(reader);
  const componentDataStructNames = readStringArray(reader);
  const componentWirePortNames = readStringArray(reader);

  const externalAssetReferences = readArray(reader, () => {
    const assetType = ensureDecoder().decode(reader.readBytes());
    const assetName = ensureDecoder().decode(reader.readBytes());
    return { assetType, assetName };
  });

  return {
    entityTypeNames,
    basicBrickAssets,
    proceduralBrickAssets,
    materialAssets,
    componentTypeNames,
    componentDataStructNames,
    componentWirePortNames,
    externalAssetReferences,
    proceduralBrickStartingIndex: basicBrickAssets.length,
  };
}

function readGuid(reader: MsgPackReader): string {
  const a = reader.readUnsigned();
  const b = reader.readUnsigned();
  const c = reader.readUnsigned();
  const d = reader.readUnsigned();
  const uuid =
    ((BigInt(a) << 96n) |
      (BigInt(b) << 64n) |
      (BigInt(c) << 32n) |
      BigInt(d)) &
    ((1n << 128n) - 1n);
  const hex = uuid.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseOwnerTable(bytes: Uint8Array): OwnerRecord[] {
  const reader = new MsgPackReader(bytes);

  const ownerIds = readArray(reader, () => readGuid(reader));
  const names = readStringArray(reader);
  const displayNames = readStringArray(reader);
  const entityCounts = readNumberArray(reader);
  const brickCounts = readNumberArray(reader);
  const componentCounts = readNumberArray(reader);
  const wireCounts = readNumberArray(reader);

  const maxLen = Math.max(
    ownerIds.length,
    names.length,
    displayNames.length,
    brickCounts.length
  );

  const owners: OwnerRecord[] = new Array(maxLen);
  for (let i = 0; i < maxLen; i++) {
    owners[i] = {
      id: ownerIds[i] ?? '00000000-0000-0000-0000-000000000000',
      name: names[i] ?? 'PUBLIC',
      displayName: displayNames[i] ?? names[i] ?? 'PUBLIC',
      brickCount: brickCounts[i] ?? 0,
    };
  }

  return owners;
}

export function parseBrickChunk(bytes: Uint8Array): BrickChunkData {
  const reader = new MsgPackReader(bytes);
  const proceduralBrickStartingIndex = reader.readUnsigned();

  const brickSizeCounters = readArray(reader, () => ({
    assetIndex: reader.readUnsigned(),
    numSizes: reader.readUnsigned(),
  }));

  const brickSizes = readArray(reader, () => ({
    x: reader.readUnsigned(),
    y: reader.readUnsigned(),
    z: reader.readUnsigned(),
  }));

  const brickTypeIndices = readNumberArray(reader);
  const ownerIndices = readNumberArray(reader);
  const relativePositions = readRelativePositions(reader);
  const orientations = readFlatBytes(reader);
  const collisionPlayer = readFlatBytes(reader);
  const collisionWeapon = readFlatBytes(reader);
  const collisionInteraction = readFlatBytes(reader);
  const collisionTool = readFlatBytes(reader);
  const collisionPhysics = readFlatBytes(reader);
  const visibility = readFlatBytes(reader);
  const materialIndices = readFlatBytes(reader);
  const colors = readColors(reader);

  return {
    proceduralBrickStartingIndex,
    brickSizeCounters,
    brickSizes,
    brickTypeIndices,
    ownerIndices,
    relativePositions,
    orientations,
    collisionPlayer,
    collisionWeapon,
    collisionInteraction,
    collisionTool,
    collisionPhysics,
    visibility,
    materialIndices,
    colors,
  };
}

function getBit(buffer: Uint8Array, index: number): boolean {
  const byte = buffer[index >> 3] ?? 0;
  const mask = 1 << (index & 7);
  return (byte & mask) !== 0;
}

function relativeToWorld(
  chunk: { x: number; y: number; z: number },
  pos: RelativePosition
): Vector {
  return [
    chunk.x * CHUNK_SIZE + CHUNK_HALF + pos.x,
    chunk.y * CHUNK_SIZE + CHUNK_HALF + pos.y,
    chunk.z * CHUNK_SIZE + CHUNK_HALF + pos.z,
  ];
}

function byteToOrientation(byte: number): { direction: Direction; rotation: Rotation } {
  const dirIndex = ((byte >> 2) % 6) as Direction;
  const rotIndex = (byte & 3) as Rotation;
  return { direction: dirIndex, rotation: rotIndex };
}

export function convertChunkToBricks(
  chunk: BrickChunkData,
  coords: { x: number; y: number; z: number },
  global: ParsedGlobalData
): IntermediateBrick[] {
  const bricks: IntermediateBrick[] = [];
  const procBrickStart = chunk.proceduralBrickStartingIndex;

  const procEntries: Array<{ size: Vector; assetIndex: number }> = [];
  let sizeCursor = 0;
  for (const counter of chunk.brickSizeCounters) {
    for (let i = 0; i < counter.numSizes; i++) {
      const size = chunk.brickSizes[sizeCursor++];
      procEntries.push({
        size: [size.x, size.y, size.z],
        assetIndex: counter.assetIndex,
      });
    }
  }

  for (let i = 0; i < chunk.brickTypeIndices.length; i++) {
    const tyIndex = chunk.brickTypeIndices[i];
    let assetName = '';
    let size: Vector = [0, 0, 0];

    if (tyIndex < procBrickStart) {
      assetName =
        global.basicBrickAssets[tyIndex] ?? global.basicBrickAssets[0] ?? 'PB_DefaultBrick';
    } else {
      const procIndex = tyIndex - procBrickStart;
      const entry = procEntries[procIndex];
      if (!entry) {
        continue;
      }
      size = entry.size;
      assetName =
        global.proceduralBrickAssets[entry.assetIndex] ??
        global.proceduralBrickAssets[0] ??
        'PB_DefaultBrick';
    }

    const position = relativeToWorld(coords, chunk.relativePositions[i]);
    const { direction, rotation } = byteToOrientation(chunk.orientations[i] ?? 0);
    const collision: Collision = {
      player: getBit(chunk.collisionPlayer, i),
      weapon: getBit(chunk.collisionWeapon, i),
      interaction: getBit(chunk.collisionInteraction, i),
      tool: getBit(chunk.collisionTool, i),
      physics: getBit(chunk.collisionPhysics, i),
    };
    const visibility = getBit(chunk.visibility, i);
    const materialIndex = chunk.materialIndices[i] ?? 0;
    const color = chunk.colors[i] ?? { r: 255, g: 255, b: 255, a: 5 };
    const ownerIndex = chunk.ownerIndices[i] ?? 0;

    bricks.push({
      assetName,
      size,
      position,
      direction,
      rotation,
      collision,
      visibility,
      materialIndex,
      materialIntensity: color.a,
      color: [color.r, color.g, color.b, color.a],
      ownerIndex,
      physicalIndex: 0,
    });
  }

  return bricks;
}

function readComponentTypeCounter(
  reader: MsgPackReader
): { typeIndex: number; numInstances: number } {
  const length = reader.readMapLength();
  let typeIndex = 0;
  let numInstances = 0;
  for (let i = 0; i < length; i++) {
    const key = reader.readString();
    switch (key) {
      case 'TypeIndex':
        typeIndex = reader.readUnsigned();
        break;
      case 'NumInstances':
        numInstances = reader.readUnsigned();
        break;
      default:
        reader.skip();
        break;
    }
  }
  return { typeIndex, numInstances };
}

export function parseComponentChunk(
  bytes: Uint8Array,
  global: ParsedGlobalData,
  schema: SchemaDefinition,
  decoder: SchemaDecoder
): ComponentChunkParseResult {
  const reader = new MsgPackReader(bytes);
  const typeCounters = readArray(reader, () => readComponentTypeCounter(reader));
  const componentBrickIndices = readNumberArray(reader);
  readNumberArray(reader); // JointBrickIndices
  readNumberArray(reader); // JointEntityReferences
  readVector3Flat(readFlatBytes(reader)); // JointInitialRelativeOffsets
  readQuaternionFlat(readFlatBytes(reader)); // JointInitialRelativeRotations

  const instances: ComponentInstance[] = [];
  const definitions = new Map<string, ComponentDefinitionInfo>();

  let cursor = 0;
  for (const counter of typeCounters) {
    const typeName =
      global.componentTypeNames[counter.typeIndex] ??
      `Component_${counter.typeIndex}`;
    const structName =
      global.componentDataStructNames[counter.typeIndex] ?? 'None';
    const structDef =
      structName !== 'None' ? schema.structs.get(structName) : undefined;

    for (let i = 0; i < counter.numInstances; i++) {
      const localIndex = componentBrickIndices[cursor] ?? 0;
      cursor++;

      let properties: AppliedComponent = {};
      if (structName !== 'None') {
        try {
          const structValue = decoder.readStruct(reader, structName);
          if (structDef) {
            properties = structPropertiesToAppliedComponent(
              structDef,
              structValue.value
            );
            ensureComponentDefinition(definitions, typeName, structDef);
          } else {
            ensureComponentDefinition(definitions, typeName);
          }
        } catch {
          ensureComponentDefinition(definitions, typeName);
        }
      } else {
        ensureComponentDefinition(definitions, typeName);
      }

      instances.push({
        typeName,
        localBrickIndex: localIndex,
        properties,
      });
    }
  }

  return { instances, definitions };
}

function readLocalWireEndpoint(reader: MsgPackReader): LocalWireEndpoint {
  const length = reader.readMapLength();
  let brickIndex = 0;
  let componentTypeIndex = 0;
  let portIndex = 0;
  for (let i = 0; i < length; i++) {
    const key = reader.readString();
    switch (key) {
      case 'BrickIndexInChunk':
        brickIndex = reader.readUnsigned();
        break;
      case 'ComponentTypeIndex':
        componentTypeIndex = reader.readUnsigned();
        break;
      case 'PortIndex':
        portIndex = reader.readUnsigned();
        break;
      default:
        reader.skip();
        break;
    }
  }
  return { brickIndex, componentTypeIndex, portIndex };
}

function readChunkIndex(reader: MsgPackReader): { x: number; y: number; z: number } {
  const length = reader.readMapLength();
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < length; i++) {
    const key = reader.readString();
    switch (key) {
      case 'X':
        x = reader.readNumber();
        break;
      case 'Y':
        y = reader.readNumber();
        break;
      case 'Z':
        z = reader.readNumber();
        break;
      default:
        reader.skip();
        break;
    }
  }
  return { x, y, z };
}

function readRemoteWireEndpoint(reader: MsgPackReader): RemoteWireEndpoint {
  const length = reader.readMapLength();
  let brickIndex = 0;
  let componentTypeIndex = 0;
  let portIndex = 0;
  let gridPersistentIndex = 0;
  let chunk = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < length; i++) {
    const key = reader.readString();
    switch (key) {
      case 'BrickIndexInChunk':
        brickIndex = reader.readUnsigned();
        break;
      case 'ComponentTypeIndex':
        componentTypeIndex = reader.readUnsigned();
        break;
      case 'PortIndex':
        portIndex = reader.readUnsigned();
        break;
      case 'GridPersistentIndex':
        gridPersistentIndex = reader.readUnsigned();
        break;
      case 'ChunkIndex':
        chunk = readChunkIndex(reader);
        break;
      default:
        reader.skip();
        break;
    }
  }
  return { brickIndex, componentTypeIndex, portIndex, gridPersistentIndex, chunk };
}

export function parseWireChunk(bytes: Uint8Array): ParsedWireChunk {
  const reader = new MsgPackReader(bytes);

  const remoteSources = readArray(reader, () => readRemoteWireEndpoint(reader));
  const localSources = readArray(reader, () => readLocalWireEndpoint(reader));
  const remoteTargets = readArray(reader, () => readLocalWireEndpoint(reader));
  const localTargets = readArray(reader, () => readLocalWireEndpoint(reader));
  readFlatBytes(reader); // PendingPropagationFlags

  const local: Array<{ source: LocalWireEndpoint; target: LocalWireEndpoint }> =
    [];
  const remote: Array<{
    source: RemoteWireEndpoint;
    target: LocalWireEndpoint;
  }> = [];

  const localCount = Math.min(localSources.length, localTargets.length);
  for (let i = 0; i < localCount; i++) {
    local.push({ source: localSources[i], target: localTargets[i] });
  }

  const remoteCount = Math.min(remoteSources.length, remoteTargets.length);
  for (let i = 0; i < remoteCount; i++) {
    remote.push({ source: remoteSources[i], target: remoteTargets[i] });
  }

  return { local, remote };
}

export function buildWriteBricks(
  bricks: IntermediateBrick[],
  assetIndexMap: Map<string, number>,
  ensureAsset: (name: string) => number
): Brick[] {
  return bricks.map(brick => {
    const assetIndex =
      assetIndexMap.get(brick.assetName) ?? ensureAsset(brick.assetName);
    return {
      asset_name_index: assetIndex,
      size: brick.size,
      position: brick.position,
      local_position: brick.localPosition,
      grid_id: brick.gridId,
      direction: brick.direction,
      rotation: brick.rotation,
      collision: brick.collision,
      visibility: brick.visibility,
      material_index: brick.materialIndex,
      physical_index: brick.physicalIndex,
      material_intensity: brick.materialIntensity,
      color: brick.color,
      owner_index: brick.ownerIndex,
      components: brick.components ? { ...brick.components } : {},
    };
  });
}

function readVector3Flat(bytes: Uint8Array): Vector[] {
  if (bytes.length % 12 !== 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Vector[] = new Array(bytes.length / 12);
  let offset = 0;
  for (let i = 0; i < result.length; i++) {
    const x = view.getFloat32(offset, true);
    offset += 4;
    const y = view.getFloat32(offset, true);
    offset += 4;
    const z = view.getFloat32(offset, true);
    offset += 4;
    result[i] = [x, y, z];
  }
  return result;
}

function readQuaternionFlat(bytes: Uint8Array): Quaternion[] {
  if (bytes.length % 16 !== 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Quaternion[] = new Array(bytes.length / 16);
  let offset = 0;
  for (let i = 0; i < result.length; i++) {
    const x = view.getFloat32(offset, true);
    offset += 4;
    const y = view.getFloat32(offset, true);
    offset += 4;
    const z = view.getFloat32(offset, true);
    offset += 4;
    const w = view.getFloat32(offset, true);
    offset += 4;
    result[i] = [x, y, z, w];
  }
  return result;
}

function readEntityTypeCounter(reader: MsgPackReader): { typeIndex: number; numEntities: number } {
  const length = reader.readMapLength();
  let typeIndex = 0;
  let numEntities = 0;
  for (let i = 0; i < length; i++) {
    const key = reader.readString();
    switch (key) {
      case 'TypeIndex':
        typeIndex = reader.readUnsigned();
        break;
      case 'NumEntities':
        numEntities = reader.readUnsigned();
        break;
      default:
        reader.skip();
        break;
    }
  }
  return { typeIndex, numEntities };
}

export function parseEntityChunk(
  bytes: Uint8Array,
  global: ParsedGlobalData
): ParsedEntity[] {
  const reader = new MsgPackReader(bytes);

  const typeCounters = readArray(reader, () => readEntityTypeCounter(reader));
  const persistentIndices = readNumberArray(reader);
  const ownerIndices = readNumberArray(reader);
  const locations = readVector3Flat(readFlatBytes(reader));
  const rotations = readQuaternionFlat(readFlatBytes(reader));

  // consume remaining fields to advance the reader
  readFlatBytes(reader); // WeldParentFlags
  readFlatBytes(reader); // PhysicsLockedFlags
  readFlatBytes(reader); // PhysicsSleepingFlags
  readNumberArray(reader); // WeldParentIndices
  readVector3Flat(readFlatBytes(reader)); // LinearVelocities
  readVector3Flat(readFlatBytes(reader)); // AngularVelocities
  readFlatBytes(reader); // ColorsAndAlphas

  const entities: ParsedEntity[] = [];
  let index = 0;
  for (const counter of typeCounters) {
    const typeName =
      global.entityTypeNames[counter.typeIndex] ?? 'Unknown';
    for (let i = 0; i < counter.numEntities; i++, index++) {
      const persistentIndex = persistentIndices[index] ?? 0;
      const ownerIndex = ownerIndices[index] ?? 0;
      const position = locations[index] ?? [0, 0, 0];
      const rotation = normalizeQuaternion(rotations[index] ?? [0, 0, 0, 1]);
      entities.push({
        typeName,
        persistentIndex,
        ownerIndex,
        position,
        rotation,
      });
    }
  }
  return entities;
}

const DIRECTION_AXES: Record<number, Vector> = {
  [Direction.XPositive]: [1, 0, 0],
  [Direction.XNegative]: [-1, 0, 0],
  [Direction.YPositive]: [0, 1, 0],
  [Direction.YNegative]: [0, -1, 0],
  [Direction.ZPositive]: [0, 0, 1],
  [Direction.ZNegative]: [0, 0, -1],
};

const BASE_ROTATIONS: Record<number, Quaternion> = {
  [Direction.ZPositive]: [0, 0, 0, 1],
  [Direction.ZNegative]: axisAngleToQuaternion([1, 0, 0], Math.PI),
  [Direction.XPositive]: axisAngleToQuaternion([0, 1, 0], Math.PI / 2),
  [Direction.XNegative]: axisAngleToQuaternion([0, 1, 0], -Math.PI / 2),
  [Direction.YPositive]: axisAngleToQuaternion([1, 0, 0], -Math.PI / 2),
  [Direction.YNegative]: axisAngleToQuaternion([1, 0, 0], Math.PI / 2),
};

const ROTATION_ANGLES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

const ORIENTATION_TABLE: Array<{
  direction: Direction;
  rotation: Rotation;
  quat: Quaternion;
}> = [];

const ALL_DIRECTIONS: Direction[] = [
  Direction.XPositive,
  Direction.XNegative,
  Direction.YPositive,
  Direction.YNegative,
  Direction.ZPositive,
  Direction.ZNegative,
];
const ALL_ROTATIONS: Rotation[] = [
  Rotation.Deg0,
  Rotation.Deg90,
  Rotation.Deg180,
  Rotation.Deg270,
];

for (const direction of ALL_DIRECTIONS) {
  for (const rotation of ALL_ROTATIONS) {
    ORIENTATION_TABLE.push({
      direction,
      rotation,
      quat: orientationToQuaternion(direction, rotation),
    });
  }
}

function axisAngleToQuaternion(axis: Vector, angle: number): Quaternion {
  const [ax, ay, az] = axis;
  let length = Math.hypot(ax, ay, az);
  if (length === 0) {
    return [0, 0, 0, 1];
  }
  const half = angle / 2;
  const sinHalf = Math.sin(half) / length;
  return normalizeQuaternion([ax * sinHalf, ay * sinHalf, az * sinHalf, Math.cos(half)]);
}

function normalizeQuaternion(quat: Quaternion): Quaternion {
  const [x, y, z, w] = quat;
  const length = Math.hypot(x, y, z, w);
  if (length === 0) {
    return [0, 0, 0, 1];
  }
  return [x / length, y / length, z / length, w / length];
}

function quaternionDot(a: Quaternion, b: Quaternion): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotateVector(quat: Quaternion, vec: Vector): Vector {
  const [vx, vy, vz] = vec;
  const [qx, qy, qz, qw] = quat;

  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;

  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function orientationToQuaternion(direction: Direction, rotation: Rotation): Quaternion {
  const base = BASE_ROTATIONS[direction] ?? [0, 0, 0, 1];
  const angle = ROTATION_ANGLES[rotation] ?? 0;
  if (angle === 0) {
    return base;
  }
  const axis = DIRECTION_AXES[direction] ?? [0, 0, 1];
  const rotQuat = axisAngleToQuaternion(axis, angle);
  return normalizeQuaternion(quatMultiply(rotQuat, base));
}

function quaternionToOrientation(quat: Quaternion): { direction: Direction; rotation: Rotation } {
  const normal = normalizeQuaternion(quat);
  let best = ORIENTATION_TABLE[0];
  let bestDot = -Infinity;
  for (const entry of ORIENTATION_TABLE) {
    const dot = Math.abs(quaternionDot(entry.quat, normal));
    if (dot > bestDot) {
      bestDot = dot;
      best = entry;
    }
  }
  return { direction: best.direction, rotation: best.rotation };
}

export function transformBricks(bricks: IntermediateBrick[], transform: GridTransform): void {
  const rotation = normalizeQuaternion(transform.rotation);
  for (const brick of bricks) {
    const rotatedPosition = rotateVector(rotation, brick.position);
    brick.position = [
      rotatedPosition[0] + transform.position[0],
      rotatedPosition[1] + transform.position[1],
      rotatedPosition[2] + transform.position[2],
    ];

    const brickQuat = orientationToQuaternion(brick.direction, brick.rotation);
    const worldQuat = normalizeQuaternion(quatMultiply(rotation, brickQuat));
    const { direction, rotation: rot } = quaternionToOrientation(worldQuat);
    brick.direction = direction;
    brick.rotation = rot;
  }
}

export function collectUniqueColors(bricks: IntermediateBrick[]): UnrealColor[] {
  const unique = new Map<string, UnrealColor>();
  for (const brick of bricks) {
    const key = brick.color.join(',');
    if (!unique.has(key)) {
      unique.set(key, brick.color);
    }
  }
  return Array.from(unique.values());
}

const PRIMITIVE_TYPE_MAP = new Map<string, string>([
  ['bool', 'Boolean'],
  ['u8', 'Integer'],
  ['i8', 'Integer'],
  ['u16', 'Integer'],
  ['i16', 'Integer'],
  ['u32', 'Integer'],
  ['i32', 'Integer'],
  ['u64', 'Integer'],
  ['i64', 'Integer64'],
  ['f32', 'Float'],
  ['f64', 'Double'],
  ['str', 'String'],
  ['class', 'Class'],
  ['object', 'Object'],
  ['wire_graph_variant', 'WireGraphVariant'],
  ['wire_graph_prim_math_variant', 'WireGraphPrimMathVariant'],
]);

function schemaTypeToPropertyType(type: string): string {
  const primitive = PRIMITIVE_TYPE_MAP.get(type);
  if (primitive) return primitive;

  switch (type) {
    case 'Color':
    case 'LinearColor':
    case 'BRSavedBrickColor':
      return 'Color';
    case 'Rotator3f':
    case 'Rotator3d':
    case 'Rotator':
      return 'Rotator';
    case 'Vector3f':
    case 'Vector3d':
    case 'Vector':
      return 'Vector3d';
    case 'IntVector':
      return 'IntVector';
    case 'Guid':
    case 'BRGuid':
      return 'String';
    case 'BRInventoryEntryPlan':
      return 'BRInventoryEntryPlan';
    default:
      return type;
  }
}

function propertyTypeFromSchema(prop: SchemaProperty): string {
  switch (prop.kind) {
    case 'type':
      return schemaTypeToPropertyType(prop.valueType);
    case 'array':
    case 'flatArray':
      return `${schemaTypeToPropertyType(prop.valueType)}[]`;
    case 'map':
      return 'Map';
    default:
      return 'Unknown';
  }
}

function convertValueForType(type: string, raw: unknown): UnrealType {
  if (raw && typeof raw === 'object' && 'structName' in (raw as any)) {
    return convertStructToUnreal(raw as StructValue) as UnrealType;
  }

  switch (type) {
    case 'bool':
      return Boolean(raw);
    case 'u8':
    case 'i8':
    case 'u16':
    case 'i16':
    case 'u32':
    case 'i32':
    case 'u64':
    case 'i64':
    case 'f32':
    case 'f64':
      return Number(raw ?? 0);
    case 'str':
      return typeof raw === 'string' ? raw : String(raw ?? '');
    case 'class':
    case 'object':
      return (raw === undefined || raw === null ? '' : String(raw)) as UnrealType;
    case 'wire_graph_variant':
    case 'wire_graph_prim_math_variant':
      return (raw ?? { exec: true }) as UnrealType;
    case 'BRInventoryEntryPlan':
      return typeof raw === 'string' ? raw : String(raw ?? '');
    default:
      return (raw as UnrealType) ?? ('' as unknown as UnrealType);
  }
}

function convertPropertyValue(prop: SchemaProperty, raw: unknown): UnrealType {
  switch (prop.kind) {
    case 'type':
      return convertValueForType(prop.valueType, raw);
    case 'array':
    case 'flatArray': {
      if (!Array.isArray(raw)) {
        return [] as unknown as UnrealType;
      }
      const converted = raw.map(item => convertValueForType(prop.valueType, item));
      return converted as unknown as UnrealType;
    }
    case 'map': {
      if (raw instanceof Map) {
        const obj: Record<string, UnrealType> = {};
        for (const [key, value] of raw.entries()) {
          obj[String(key)] = convertValueForType(prop.valueType, value);
        }
        return obj as unknown as UnrealType;
      }
      if (raw && typeof raw === 'object') {
        const objRaw = raw as Record<string, unknown>;
        const obj: Record<string, UnrealType> = {};
        for (const key of Object.keys(objRaw)) {
          obj[key] = convertValueForType(prop.valueType, objRaw[key]);
        }
        return obj as unknown as UnrealType;
      }
      return {} as unknown as UnrealType;
    }
    default:
      return raw as UnrealType;
  }
}

function structPropertiesToAppliedComponent(
  structDef: SchemaStruct,
  raw: Record<string, unknown>
): AppliedComponent {
  const applied: AppliedComponent = {};
  for (const prop of structDef.properties) {
    const rawValue = raw[prop.name];
    applied[prop.name] = convertPropertyValue(prop, rawValue);
  }
  return applied;
}

function ensureComponentDefinition(
  definitions: Map<string, ComponentDefinitionInfo>,
  typeName: string,
  structDef?: SchemaStruct
): ComponentDefinitionInfo {
  const entry =
    definitions.get(typeName) ??
    { version: 1, propertyTypes: {} as Record<string, string> };
  if (structDef) {
    for (const prop of structDef.properties) {
      entry.propertyTypes[prop.name] = propertyTypeFromSchema(prop);
    }
  }
  definitions.set(typeName, entry);
  return entry;
}
